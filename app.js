// Enoch signing page.
// One job: create an HCS topic, then submit one message to it.
// All signing happens in the connected HashPack wallet over WalletConnect.
// This file never handles a seed phrase or a private key. There is no backend.
// The topic admin key and submit key are the connected account public key,
// read from the public mirror node record for the account. That key is
// already public. The SDK method createTopic() cannot take a public key
// (its source calls PrivateKey.fromString on the key), so the page builds
// the TopicCreateTransaction directly with @hashgraph/sdk and executes it
// through the wallet signer, exactly as the SDK does internally.
// The message submit is built the same way, so the page knows the
// transaction ID and can look up the exact fee. No submit key is passed,
// because the topic submit key is the connected account key, so the wallet
// signer signs it. No private key enters the page at any point.

// The SDK is loaded from dist/hashinal-wc.umd.js (pinned
// @hashgraphonline/hashinal-wc 2.0.64). On load it sets
// window.HashinalsWalletConnectSDK to the singleton instance and
// window.HashgraphSDK to the @hashgraph/sdk namespace.
// If the SDK script failed to load, the page says so instead of dying
// silently. Nothing below runs without it.
if (!window.HashinalsWalletConnectSDK || !window.HashgraphSDK) {
  document.addEventListener("DOMContentLoaded", function () {
    var box = document.getElementById("errorBox");
    if (box) {
      box.textContent =
        "The signing library (dist/hashinal-wc.umd.js) did not load. Check the page files are all present, then reload.";
      box.style.display = "block";
    }
  });
  throw new Error("Hashinal WalletConnect SDK did not load.");
}

var sdk = window.HashinalsWalletConnectSDK;
var HashgraphSDK = window.HashgraphSDK;
var LedgerId = HashgraphSDK.LedgerId;

// HashPack returns the node ID in the executed-transaction reply as a
// number (for example 3) instead of the string "0.0.3". The SDK's
// TransactionResponse.fromJSON passes it straight to
// AccountId.fromString, which calls .startsWith on it and throws
// "startsWith is not a function". That throw happens after the wallet
// has already signed and executed, so a success looks like a failure.
// Normalize the reply first, so a success reply parses. Reproduced
// locally Nov 27, 2026: fromJSON with a numeric nodeId throws exactly
// "startsWith is not a function", with a string nodeId it parses.
(function patchTransactionResponseFromJSON() {
  var TR = HashgraphSDK.TransactionResponse;
  if (!TR || !TR.fromJSON || TR.fromJSON.__enochPatched) return;
  var original = TR.fromJSON;
  var patched = function (json) {
    if (json && typeof json === "object") {
      var copy = {};
      for (var k in json) copy[k] = json[k];
      if (typeof copy.nodeId === "number") {
        copy.nodeId = "0.0." + copy.nodeId;
      } else if (copy.nodeId && typeof copy.nodeId === "object") {
        var n = copy.nodeId;
        if (typeof n.num !== "undefined") {
          copy.nodeId = (n.shard || 0) + "." + (n.realm || 0) + "." + n.num;
        }
      }
      if (copy.transactionId && typeof copy.transactionId !== "string") {
        copy.transactionId = String(copy.transactionId);
      }
      json = copy;
    }
    return original.call(TR, json);
  };
  patched.__enochPatched = true;
  TR.fromJSON = patched;
})();

// The wallet reply is parsed by a SECOND copy of the same parser, inside
// the bundled wallet-connect layer (the @hiero-ledger/sdk copy), not the
// window copy patched above, so patching fromJSON alone does not reach
// it. Instead, wrap the connected signer's request method once: when the
// wallet answers hedera_signAndExecuteTransaction, normalize its node ID
// and transaction ID to strings before the parser sees them. All other
// requests pass through untouched. Best effort: if the signer cannot be
// found, the transaction continues and any error surfaces normally.
function patchSignerRequest() {
  try {
    var connector = sdk.dAppConnector;
    if (!connector) return "no wallet connector on the page";
    if (!connector.signers || connector.signers.length === 0) return "no signer found";
    for (var i = 0; i < connector.signers.length; i++) {
      var signer = connector.signers[i];
      if (!signer || !signer.getAccountId) continue;
      if (signer.getAccountId().toString() !== accountId) continue;
      if (!signer.request) return "signer has no request method";
      if (signer.request.__enochPatched) return "reply fix already on";
      var origRequest = signer.request.bind(signer);
      var wrapped = async function (req) {
        var res = await origRequest(req);
        if (req && req.method === "hedera_signAndExecuteTransaction" && res && typeof res === "object") {
          var copy = {};
          for (var k in res) copy[k] = res[k];
          if (typeof copy.nodeId === "number") {
            copy.nodeId = "0.0." + copy.nodeId;
          } else if (copy.nodeId && typeof copy.nodeId === "object" && typeof copy.nodeId.num !== "undefined") {
            copy.nodeId = (copy.nodeId.shard || 0) + "." + (copy.nodeId.realm || 0) + "." + copy.nodeId.num;
          }
          if (copy.transactionId && typeof copy.transactionId !== "string") {
            copy.transactionId = String(copy.transactionId);
          }
          res = copy;
        }
        return res;
      };
      wrapped.__enochPatched = true;
      signer.request = wrapped;
      return "reply fix on";
    }
    return "no signer matched this account";
  } catch (e) {
    return "reply fix failed: " + (e && e.message ? e.message : String(e));
  }
}

// Short diagnostic shown with any failure, so the exact step that threw
// is visible on the page instead of only the error text.
function errorDetail(stage, patchState, e) {
  var text = "Failed at " + stage + ". Reply fix: " + patchState + ". Error: " + (e && e.message ? e.message : String(e));
  if (e && e.stack) {
    var stack = String(e.stack).replace(/\n/g, " | ").slice(0, 400);
    text += " Stack: " + stack;
  }
  return text;
}

var MESSAGE =
  '{"spec":"1.1","digest":"01ae732d5bf4476f8159d2a02e23c58a6f33044d0dae2d0bd8a605c057187284","envelope":"record_id=EN-2026-0001;event=document.captured;file=engagement-letter.pdf;captured_at=2026-10-15T21:42:18Z","domain":"enoch.goodcode.ca"}';
var TOPIC_MEMO = "Enoch verification records";
var DEFAULT_PROJECT_ID = "30e6b7be7e28aa8c55317773c9534d57";
var PROJECT_ID_PLACEHOLDER = "REPLACE_WITH_YOUR_WALLETCONNECT_CLOUD_PROJECT_ID";
var MIRRORS = {
  mainnet: ["https://mainnet-public.mirrornode.hedera.com"],
  testnet: [
    "https://testnet-public.mirrornode.hedera.com",
    "https://testnet.mirrornode.hedera.com",
  ],
};
var HASHSCAN = {
  mainnet: "https://hashscan.io/mainnet",
  testnet: "https://hashscan.io/testnet",
};

var accountId = null;
var network = "mainnet";
var accountPublicKey = null;
var accountPublicKeyDer = null;
var topicId = null;

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text;
}

function showError(text) {
  var box = $("errorBox");
  box.textContent = text;
  box.style.display = "block";
}

function clearError() {
  $("errorBox").style.display = "none";
  $("errorBox").textContent = "";
}

function selectedNetwork() {
  var radios = document.getElementsByName("network");
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) return radios[i].value;
  }
  return "mainnet";
}

function setNetworkLocked(locked) {
  var radios = document.getElementsByName("network");
  for (var i = 0; i < radios.length; i++) radios[i].disabled = locked;
}

// Mirror node transaction IDs use dashes: 0.0.123-1700000000-123456789
function txIdToDashed(txIdString) {
  var at = txIdString.indexOf("@");
  var head = txIdString.slice(0, at);
  var rest = txIdString.slice(at + 1).replace(".", "-");
  return head + "-" + rest;
}

async function fetchChargedFee(txIdString) {
  try {
    var hosts = MIRRORS[network];
    for (var i = 0; i < hosts.length; i++) {
      try {
        var url = hosts[i] + "/api/v1/transactions/" + txIdToDashed(txIdString);
        var res = await fetch(url);
        if (!res.ok) continue;
        var data = await res.json();
        var tx = data.transactions && data.transactions[0];
        if (!tx || typeof tx.charged_fee !== "number") return "not shown yet, check HashScan";
        return (tx.charged_fee / 100000000).toFixed(8) + " HBAR";
      } catch (e) {
        // Try the next mirror host.
      }
    }
    return "not shown yet, check HashScan";
  } catch (e) {
    return "not shown yet, check HashScan";
  }
}

async function connectWallet() {
  clearError();
  var projectId = $("projectId").value.trim();
  if (!projectId || projectId === PROJECT_ID_PLACEHOLDER) {
    showError(
      "A WalletConnect Cloud project ID is needed first. Paste one above. Get a free one at cloud.walletconnect.com."
    );
    return;
  }
  try {
    localStorage.setItem("enoch-wc-project-id", projectId);
  } catch (e) {
    // Storage is optional. The page works without it.
  }
  network = selectedNetwork();
  setStatus("Connecting. Approve the connection in HashPack.");
  $("connectBtn").disabled = true;
  try {
    var ledgerId = network === "testnet" ? LedgerId.TESTNET : LedgerId.MAINNET;
    try {
      await sdk.init(
        projectId,
        {
          name: "Enoch signing page",
          description: "Create one HCS topic and submit one message, signing in HashPack.",
          url: window.location.href,
          icons: [],
        },
        ledgerId
      );
      await sdk.connect();
    } catch (e) {
      throw new Error(
        "WalletConnect step failed: " + (e && e.message ? e.message : String(e))
      );
    }
    var info = sdk.getAccountInfo();
    if (!info || !info.accountId) throw new Error("Connected, but no account was returned by the wallet.");
    if (info.network && info.network.toString() !== ledgerId.toString()) {
      throw new Error(
        "The wallet connected on " +
          info.network.toString() +
          " but this page is set to " +
          network +
          ". Switch the network in HashPack, or pick the matching network above and reconnect."
      );
    }
    accountId = info.accountId;
    var balance = await sdk.getAccountBalance();
    var acct = null;
    var mirrorError = null;
    var hosts = MIRRORS[network];
    for (var i = 0; i < hosts.length; i++) {
      try {
        var res = await fetch(hosts[i] + "/api/v1/accounts/" + accountId);
        if (!res.ok) throw new Error("HTTP " + res.status);
        acct = await res.json();
        break;
      } catch (e) {
        mirrorError = e;
      }
    }
    if (!acct) {
      throw new Error(
        "Mirror node step failed: could not read the account record. " +
          (mirrorError && mirrorError.message ? mirrorError.message : String(mirrorError))
      );
    }
    if (!acct.key || typeof acct.key.key !== "string") {
      throw new Error("The mirror node record for this account has no public key. Cannot build the topic.");
    }
    accountPublicKeyDer = acct.key.key;
    accountPublicKey = HashgraphSDK.PublicKey.fromString(accountPublicKeyDer);

    $("accountId").textContent = accountId;
    $("networkName").textContent = network;
    $("balance").textContent = balance === null ? "unknown" : balance;
    $("publicKey").textContent = accountPublicKeyDer;
    $("accountBox").style.display = "block";
    $("connectBtn").disabled = true;
    $("disconnectBtn").disabled = false;
    $("createTopicBtn").disabled = false;
    setNetworkLocked(true);
    setStatus("Connected. Check the account and public key above, then run Step 1.");
  } catch (e) {
    $("connectBtn").disabled = false;
    showError("Connection failed: " + (e && e.message ? e.message : String(e)));
    setStatus("");
  }
}

async function disconnectWallet() {
  clearError();
  try {
    await sdk.disconnect();
  } catch (e) {
    // Disconnect is best effort. Reset the page state either way.
  }
  accountId = null;
  accountPublicKey = null;
  accountPublicKeyDer = null;
  topicId = null;
  $("accountBox").style.display = "none";
  $("topicResult").style.display = "none";
  $("msgResult").style.display = "none";
  $("submitTopicId").textContent = "not created yet";
  $("connectBtn").disabled = false;
  $("disconnectBtn").disabled = true;
  $("createTopicBtn").disabled = true;
  $("submitMsgBtn").disabled = true;
  setNetworkLocked(false);
  setStatus("Disconnected.");
}

async function createTopic() {
  clearError();
  if (!accountId || !accountPublicKey) {
    showError("Connect a wallet first.");
    return;
  }
  setStatus("Creating the topic. Approve it in HashPack.");
  $("createTopicBtn").disabled = true;
  var stage = "starting";
  var patchState = "not tried yet";
  try {
    stage = "applying the wallet reply fix";
    patchState = patchSignerRequest();
    stage = "checking the public record for an existing topic";
    // A previous attempt may have created the topic and then failed while
    // parsing the wallet's reply, so check the mirror node first. If a
    // topic with this exact memo already exists for this account, use it
    // instead of paying to create a second one. A failed lookup does not
    // block creation.
    try {
      var hosts = MIRRORS[network];
      for (var h = 0; h < hosts.length; h++) {
        try {
          var listRes = await fetch(
            hosts[h] + "/api/v1/topics?account.id=" + accountId + "&limit=100"
          );
          if (!listRes.ok) continue;
          var listData = await listRes.json();
          var found = null;
          var foundTs = "";
          var topics = listData.topics || [];
          for (var t = 0; t < topics.length; t++) {
            var memo = "";
            try {
              memo = atob(topics[t].memo_base64 || "");
            } catch (e2) {
              memo = "";
            }
            if (memo === TOPIC_MEMO && (topics[t].created_timestamp || "") >= foundTs) {
              found = topics[t];
              foundTs = topics[t].created_timestamp || "";
            }
          }
          if (found) {
            topicId = found.topic_id;
            $("topicId").textContent = topicId;
            $("topicTxId").textContent = "created in an earlier attempt, see HashScan";
            $("topicFee").textContent = "already paid";
            var foundLink = HASHSCAN[network] + "/topic/" + topicId;
            $("topicHashScan").href = foundLink;
            $("topicResult").style.display = "block";
            $("submitTopicId").textContent = topicId;
            $("submitMsgBtn").disabled = false;
            setStatus("Topic already exists: " + topicId + ". No new topic was created. Check it on HashScan, then run Step 2.");
            return;
          }
          break;
        } catch (e3) {
          // Try the next mirror host.
        }
      }
    } catch (e4) {
      // Mirror lookup is best effort. Creation continues below.
    }
    stage = "building the transaction";
    var tx = new HashgraphSDK.TopicCreateTransaction()
      .setTopicMemo(TOPIC_MEMO)
      .setAdminKey(accountPublicKey)
      .setSubmitKey(accountPublicKey);
    // Do not set the transaction ID here. The wallet signer sets it during
    // freezeWithSigner, and setting it first locks the ID list, so the
    // signer then throws "list is locked" before any request reaches the
    // wallet. The ID is read from the transaction after execution instead.
    stage = "signing and executing in HashPack (approve it there)";
    var receipt = await sdk.executeTransaction(tx);
    stage = "reading the receipt";
    var txIdString = tx.transactionId ? tx.transactionId.toString() : "not shown yet, check HashScan";
    if (!receipt || !receipt.topicId) throw new Error("No topic ID came back in the receipt.");
    topicId = receipt.topicId.toString();
    stage = "reading the fee";
    var fee = await fetchChargedFee(txIdString);
    $("topicId").textContent = topicId;
    $("topicTxId").textContent = txIdString;
    $("topicFee").textContent = fee;
    var link = HASHSCAN[network] + "/topic/" + topicId;
    $("topicHashScan").href = link;
    $("topicResult").style.display = "block";
    $("submitTopicId").textContent = topicId;
    $("submitMsgBtn").disabled = false;
    setStatus("Topic created: " + topicId + ". Check it on HashScan, then run Step 2.");
  } catch (e) {
    $("createTopicBtn").disabled = false;
    showError("Topic creation failed. " + errorDetail(stage, patchState, e));
    setStatus("");
  }
}

async function submitMessage() {
  clearError();
  if (!topicId) {
    showError("Create the topic first.");
    return;
  }
  setStatus("Submitting the message. Approve it in HashPack.");
  $("submitMsgBtn").disabled = true;
  var stage = "starting";
  var patchState = "not tried yet";
  try {
    stage = "applying the wallet reply fix";
    patchState = patchSignerRequest();
    stage = "building the transaction";
    var tx = new HashgraphSDK.TopicMessageSubmitTransaction()
      .setTopicId(HashgraphSDK.TopicId.fromString(topicId))
      .setMessage(MESSAGE);
    // Do not set the transaction ID here, for the same reason as in
    // createTopic: the wallet signer sets it, and setting it first makes the
    // signer throw "list is locked".
    stage = "signing and executing in HashPack (approve it there)";
    var receipt = await sdk.executeTransaction(tx);
    stage = "reading the receipt";
    var txIdString = tx.transactionId ? tx.transactionId.toString() : "not shown yet, check HashScan";
    var seq = receipt && receipt.topicSequenceNumber ? receipt.topicSequenceNumber.toString() : null;
    var consensusTs = null;
    try {
      var hosts = MIRRORS[network];
      for (var i = 0; i < hosts.length; i++) {
        try {
          var url =
            hosts[i] + "/api/v1/topics/" + topicId + "/messages?limit=1&order=desc";
          var res = await fetch(url);
          if (!res.ok) continue;
          var data = await res.json();
          var msg = data.messages && data.messages[0];
          if (msg) {
            seq = String(msg.sequence_number);
            consensusTs = msg.consensus_timestamp;
            if (msg.message) {
              var decoded = atob(msg.message);
              if (decoded !== MESSAGE) {
                throw new Error(
                  "The message on the ledger does not match the message shown on this page. Do not trust this result."
                );
              }
            }
          }
          break;
        } catch (e) {
          // Try the next mirror host.
        }
      }
    } catch (e) {
      if (e && e.message && e.message.indexOf("does not match") !== -1) throw e;
      // Mirror node read failures are not fatal. The receipt is the proof.
    }
    var fee = await fetchChargedFee(txIdString);
    $("seqNum").textContent = seq === null ? "see HashScan" : seq;
    $("consensusTs").textContent = consensusTs === null ? "see HashScan" : consensusTs;
    $("msgTxId").textContent = txIdString;
    $("msgFee").textContent = fee;
    var link = HASHSCAN[network] + "/topic/" + topicId;
    $("msgHashScan").href = link;
    $("msgResult").style.display = "block";
    setStatus("Message submitted to topic " + topicId + ". Verify it on HashScan.");
  } catch (e) {
    $("submitMsgBtn").disabled = false;
    showError("Message submit failed. " + errorDetail(stage, patchState, e));
    setStatus("");
  }
}

function init() {
  try {
    var saved = localStorage.getItem("enoch-wc-project-id");
    if (saved) {
      $("projectId").value = saved;
    } else {
      $("projectId").value = DEFAULT_PROJECT_ID;
    }
  } catch (e) {
    // Storage is optional.
    $("projectId").value = DEFAULT_PROJECT_ID;
  }
  $("connectBtn").addEventListener("click", connectWallet);
  $("disconnectBtn").addEventListener("click", disconnectWallet);
  $("createTopicBtn").addEventListener("click", createTopic);
  $("submitMsgBtn").addEventListener("click", submitMessage);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
