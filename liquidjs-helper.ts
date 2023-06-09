import {
  Extractor,
  Finalizer,
  Pset,
  PsetGlobal,
  Transaction,
  witnessStackToScriptWitness,
} from "liquidjs-lib";
import * as liquid from "liquidjs-lib";
import { keypair } from "./keys";
let ecc = require("tiny-secp256k1");
import { NETWORK } from "./constants";
import { varuint } from "liquidjs-lib/src/bufferutils";
import ElementsClient from "./elements-client";
import {
  IssueAssetResponse,
  SimplifiedVerboseGetRawTransactionResponse,
} from "./elements-client/module";
import { LEAF_VERSION_TAPSCRIPT } from "liquidjs-lib/src/bip341";

export interface SendResult {
  tx: SimplifiedVerboseGetRawTransactionResponse;
  outputIndex: number;
}

const elementsClient = new ElementsClient();

export async function issueAsset(
  amount: number,
  reissuanceTokenAmount: number = 0
): Promise<{ issuanceTxId: string; assetId: string }> {
  let issuanceResponse: IssueAssetResponse = await elementsClient.issueAsset(
    amount / 100_000_000,
    reissuanceTokenAmount
  );

  return {
    issuanceTxId: issuanceResponse.txid,
    assetId: issuanceResponse.asset,
  };
}

export function getCovenantAddress(
  covenantScriptASM: string,
  internalPublicKey: Buffer
): string {
  const leafScript = liquid.script.fromASM(covenantScriptASM);

  let leaves = [
    {
      scriptHex: leafScript.toString("hex"),
    },
  ];

  let hashTree = liquid.bip341.toHashTree(leaves);
  let bip341Factory = liquid.bip341.BIP341Factory(ecc);
  let output = bip341Factory.taprootOutputScript(internalPublicKey, hashTree);
  let p2trAddress = liquid.address.fromOutputScript(output, NETWORK);

  if (!p2trAddress) {
    throw new Error("Address could not be derived");
  }

  return p2trAddress;
}

let getOutputForAssetId = (tx, assetId) => {
  let { vout } = tx;

  for (let i = 0; i < vout.length; i++) {
    if (vout[i].asset == assetId && vout[i].scriptPubKey.asm) {
      return i;
    }
  }

  return -1;
};

function convertToBitcoinUnits(amount) {
  return amount / 100_000_000;
}

export async function spendToAddress({
  assetId,
  address,
  amount: amountInSatoshis,
}: {
  assetId: string;
  address: string;
  amount: number;
}): Promise<SendResult> {
  let sendToAddressTxId = await elementsClient.sendToAddress(
    address,
    convertToBitcoinUnits(amountInSatoshis),
    assetId
  );
  let tx = await elementsClient.getRawTransaction(sendToAddressTxId);
  let outputIndex = getOutputForAssetId(tx, assetId);

  return {
    tx,
    outputIndex,
  };
}

export function toXOnly(key: Buffer) {
  return key.subarray(1);
}

export function getOutputWitnessScriptData(
  script,
  internalPublicKey
): {
  parity: number;
  encodedScriptSize: Buffer;
} {
  let leaves = [
    {
      scriptHex: script.toString("hex"),
    },
  ];

  let leafHash = liquid.bip341.tapLeafHash(leaves[0]);
  let hashTree = liquid.bip341.toHashTree(leaves);
  let path = liquid.bip341.findScriptPath(hashTree, leafHash);

  const bip341Factory = liquid.bip341.BIP341Factory(ecc);
  let taprootStack = bip341Factory.taprootSignScriptStack(
    internalPublicKey,
    leaves[0],
    hashTree.hash,
    path
  );

  let parity = taprootStack[1][0] % LEAF_VERSION_TAPSCRIPT;
  let encodedScriptSize = varuint.encode(script.length);
  return {
    parity,
    encodedScriptSize,
  };
}

export async function spendFromCovenant({
  covenantScript,
  inputs,
  outputs,
  internalPublicKey,
  spendFromCovenantDestinationScriptStart,
  fullScript,
}: {
  covenantScript: Buffer;
  inputs: any;
  outputs: Array<any>;
  internalPublicKey: Buffer;
  spendFromCovenantDestinationScriptStart: Buffer;
  fullScript: Buffer;
}): Promise<any> {
  const TRANSACTION_VERSION = 2;
  let pset = new Pset(
    new PsetGlobal(TRANSACTION_VERSION, inputs.length, outputs.length),
    inputs,
    outputs
  );

  let leaves = [
    {
      scriptHex: covenantScript.toString("hex"),
    },
  ];

  let outputWitnessScriptData = getOutputWitnessScriptData(
    fullScript,
    internalPublicKey
  );

  let leafHash = liquid.bip341.tapLeafHash(leaves[0]);
  let hashTree = liquid.bip341.toHashTree(leaves);
  const bip341Factory = liquid.bip341.BIP341Factory(ecc);

  // Path will always be '[]' since we only have one script in tree
  let path = liquid.bip341.findScriptPath(hashTree, leafHash);
  let taprootStack = bip341Factory.taprootSignScriptStack(
    internalPublicKey,
    leaves[0],
    hashTree.hash,
    path
  );

  pset.inputs[0].finalScriptWitness = witnessStackToScriptWitness([
    Buffer.from([outputWitnessScriptData.parity ? 3 : 2]),
    Buffer.alloc(0),
    Buffer.concat([
      outputWitnessScriptData.encodedScriptSize,
      spendFromCovenantDestinationScriptStart,
    ]),
    toXOnly(internalPublicKey),
    ...taprootStack,
  ]);

  const preimage = pset.getInputPreimage(
    1,
    Transaction.SIGHASH_ALL,
    NETWORK.genesisBlockHash
  );

  pset.inputs[1].partialSigs = [];
  pset.inputs[1].partialSigs.push({
    pubkey: keypair.publicKey,
    signature: liquid.script.signature.encode(
      keypair.sign(preimage),
      Transaction.SIGHASH_ALL
    ),
  });

  let finalizer = new Finalizer(pset);
  finalizer.finalizeInput(1);

  const tx = Extractor.extract(pset);
  const hex = tx.toHex();
  return broadcastTx(hex);
}

export async function broadcastTx(tx: string): Promise<any> {
  try {
    let response = await elementsClient
      .getRawClient()
      .request("sendrawtransaction", {
        hexstring: tx,
      });

    console.log(`Successfully broadcast transaction: ${response}\n\n`);

    try {
      let address = await elementsClient
        .getRawClient()
        .request("getnewaddress");

      await elementsClient.getRawClient().request("generatetoaddress", {
        address: address,
        nblocks: 10,
      });
    } catch (err) {
      console.log("Error generating blocks");
    }

    return response;
  } catch (err) {
    console.log("\n\n", (err as any).message, "\n\n");
    return Promise.reject();
  }
}
