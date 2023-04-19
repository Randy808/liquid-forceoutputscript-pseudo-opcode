import * as liquid from "liquidjs-lib";
import {
  issueAsset,
  getCovenantAddress,
  spendToAddress as spendToAddress,
  spendFromCovenant,
  SendResult,
} from "./liquidjs-helper";
import { keypair } from "./keys";
import {
  INTERNAL_PUBLIC_KEY,
  ISSUANCE_AMOUNT_IN_SATOSHIS,
  LBTC_ASSET_ID,
  LEAF_VERSION_HEX,
  NETWORK,
  TRANSACTION_FEE_IN_SATOSHIS,
  TapLeafTaggedHashPrefixHex,
  TapTweakTaggedHashPrefixHex,
} from "./constants";
import { createInput } from "./utils";

//{parity} {index} {output_script} {internal pubkey} OP_FORCE_OUTPUT_SCRIPT_VERIFY
function OP_FORCE_OUTPUT_SCRIPT_VERIFY(): string {
  let storeCopyOfXOnlyInternalPubkeyOnAltStack = `OP_DUP OP_TOALTSTACK`;

  let createTweakMessagePrefix = `${TapTweakTaggedHashPrefixHex} OP_SWAP OP_CAT`;
  let createTapLeafHashMessage = `${TapLeafTaggedHashPrefixHex}${LEAF_VERSION_HEX} OP_2 OP_ROLL OP_CAT`;
  let hashIntoTweakAndMoveToAltStack = `${createTweakMessagePrefix} ${createTapLeafHashMessage} OP_SHA256 OP_CAT OP_SHA256 OP_TOALTSTACK`;
  
  let validateTweakFromAltStack = `OP_INSPECTOUTPUTSCRIPTPUBKEY OP_VERIFY OP_CAT OP_FROMALTSTACK OP_FROMALTSTACK OP_TWEAKVERIFY`;

  return (
    `${storeCopyOfXOnlyInternalPubkeyOnAltStack} ` +
    `${hashIntoTweakAndMoveToAltStack} ` +
    `${validateTweakFromAltStack}`
  );
}

async function main() {
  // YOU CAN CHANGE THE 2 VALUES BELOW
  // Be mindful of the 80 byte witness stack item limit when defining spendFromCovenantDestinationScriptStart

  // This is the required part of the destination script that will be committed to by the covenant
  const spendFromCovenantDestinationScriptEnd = `OP_CHECKSIG`;

  // This is the full script that includes the requirement at the end.
  const spendFromCovenantDestinationScriptStart = `${INTERNAL_PUBLIC_KEY.toString(
    "hex"
  )}`;

  /************************/

  console.log("Issuing new asset...");
  let { assetId } = await issueAsset(ISSUANCE_AMOUNT_IN_SATOSHIS);
  console.log(`Generated asset id ${assetId}\n\n`);

  /************************/

  console.log("Creating covenant address...");
  const spendFromCovenantDestinationScript =
    `${spendFromCovenantDestinationScriptStart} ${spendFromCovenantDestinationScriptEnd}`.trim();

  let covenantScript = `${OP_FORCE_OUTPUT_SCRIPT_VERIFY()} OP_1`;

  if (spendFromCovenantDestinationScriptEnd) {
    let serializedScriptEnd = liquid.script
      .fromASM(spendFromCovenantDestinationScriptEnd)
      .toString("hex");

    let attachScriptEnd = serializedScriptEnd
      ? `OP_1 OP_ROLL ${serializedScriptEnd} OP_CAT OP_SWAP`
      : "";

    covenantScript = `${attachScriptEnd} ${covenantScript}`;
  }

  let covenantAddress = await getCovenantAddress(
    covenantScript.trim(),
    INTERNAL_PUBLIC_KEY
  );

  /************************/

  console.log("Spending to covenant...");
  let spendToCovenantTx: SendResult = await spendToAddress({
    assetId: assetId,
    address: covenantAddress,
    amount: ISSUANCE_AMOUNT_IN_SATOSHIS,
  });
  console.log(
    `Sent asset to covenant address: ${covenantAddress}\nTxid: ${spendToCovenantTx.tx.txid}\n\n`
  );

  /************************/

  console.log("Sending LBTC to test address...");
  let { address: keypairAddress } = liquid.payments.p2wpkh({
    pubkey: keypair.publicKey,
    network: NETWORK,
  });
  const covenantFundingSpendResult: SendResult = await spendToAddress({
    assetId: LBTC_ASSET_ID,
    address: keypairAddress!,
    amount: 500,
  });
  console.log(
    `sendToAddress (BTC) result: ${covenantFundingSpendResult.tx.txid}\n\n`
  );

  /************************/

  console.log("Spending to covenant...");
  let inputs: any = [];
  // Any changes to the order here will require changes in 'spendFromCovenant'.
  inputs.push(createInput(spendToCovenantTx));
  inputs.push(createInput(covenantFundingSpendResult));

  // If the first argument 'spendFromCovenantDestinationScript' is replaced with a script
  // that doesn't end with 'spendFromCovenantDestinationScriptEnd', the covenant spend will
  // fail
  let spendFromCovenantDestinationScriptAddress = await getCovenantAddress(
    spendFromCovenantDestinationScript,
    INTERNAL_PUBLIC_KEY
  );

  let outputs = [
    new liquid.PsetOutput(
      ISSUANCE_AMOUNT_IN_SATOSHIS,
      Buffer.from(assetId, "hex").reverse(),
      liquid.address.toOutputScript(spendFromCovenantDestinationScriptAddress)
    ),
    new liquid.PsetOutput(
      TRANSACTION_FEE_IN_SATOSHIS,
      Buffer.from(LBTC_ASSET_ID, "hex").reverse(),
      Buffer.alloc(0)
    ),
  ];

  let spendFromCovenantTxId = await spendFromCovenant({
    covenantScript: liquid.script.fromASM(covenantScript),
    inputs,
    outputs,
    internalPublicKey: INTERNAL_PUBLIC_KEY,
    spendFromCovenantDestinationScriptStart: liquid.script.fromASM(
      spendFromCovenantDestinationScriptStart
    ),
    fullScript: liquid.script.fromASM(spendFromCovenantDestinationScript),
  });

  console.log(`Successfully spent from covenant: ${spendFromCovenantTxId}`);
  console.log("DONE");
}

main();
