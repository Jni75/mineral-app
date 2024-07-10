/* eslint-disable fp/no-loops, fp/no-mutation, fp/no-mutating-methods, fp/no-let, no-constant-condition */

import { keccak_256 } from "@noble/hashes/sha3";
import { mine } from "./codegen/mineral/mine/functions";
import { register } from "./codegen/mineral/miner/functions";
import { SUI_CLOCK_OBJECT_ID, MIST_PER_SUI } from "@mysten/sui.js/utils";
import { ProofData } from "./ports";
import * as constants from "./constants";
import {
  TransactionEffects,
  ExecutionStatus,
  SuiClient,
  SuiTransactionBlockResponse,
} from "@mysten/sui.js/client";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import { Ed25519Keypair } from "@mysten/sui.js/dist/cjs/keypairs/ed25519";
import { Bus } from "./codegen/mineral/mine/structs";
import { Miner } from "./codegen/mineral/miner/structs";
import { SignatureWithBytes } from "@mysten/sui.js/dist/cjs/cryptography";
import { TurbosSdk } from "turbos-clmm-sdk";

export type MineEvent =
  | "resetting"
  | "retrying"
  | "simulating"
  | "submitting"
  | "success"
  | "checkpoint"
  | "waiting";

export const getClient = () => {
  return new SuiClient({
    url: new URL(process.env.RPC!).toString(),
  });
};

export async function calcProfit(sdk: TurbosSdk, amount: bigint) {
  const MINE_GAS_FEE = 811_644;

  const [swap] = await sdk.trade.computeSwapResultV2({
    pools: [
      {
        pool: "0x36f838ab69ea41d959de58dd5b2cb00c9deb7bc1e851a82097b66dfd629f0f3f",
        a2b: true,
        amountSpecified: amount.toString(),
      },
    ],
    address:
      "0x7da95f2a3898d8aabbb9b67fb0130c029c73085340db8b21373c514c608e65fe",
    amountSpecifiedIsInput: true,
  });
  const out =
    Number(swap.amount_b) + Number(swap.protocol_fee) + Number(swap.fee_amount);
  const delta = (out - MINE_GAS_FEE) / Number(MIST_PER_SUI);
  return {
    mineGasFee: MINE_GAS_FEE / Number(MIST_PER_SUI),
    swapOutput: out / Number(MIST_PER_SUI),
    delta,
  };
}

export function fetchBus(client: SuiClient) {
  return Bus.fetch(client, constants.BUSES[0]);
}

export async function findValidBus(client: SuiClient): Promise<Bus | null> {
  const buses = await fetchBuses(client);

  const bus = buses[0];

  if (bus.rewards.value >= bus.rewardRate) {
    const threshold = Number(bus.lastReset) + constants.EPOCH_LENGTH;

    const buffer = 8_000;
    const closeToReset = Date.now() >= threshold - buffer;

    return closeToReset ? null : bus;
  } else {
    return null;
  }
}

export async function fetchBuses(client: SuiClient): Promise<Bus[]> {
  const objs = await client.multiGetObjects({
    ids: constants.BUSES,
    options: { showContent: true },
  });
  const buses = objs.map((obj) => {
    const bus = Bus.fromFieldsWithTypes(obj.data!.content! as any);
    return bus;
  });

  // Put buses with most rewards to the start
  buses.sort((a, b) => Number(a.rewards.value - b.rewards.value));
  buses.reverse();

  return buses;
}

export async function estimateGasAndSubmit(
  txb: TransactionBlock,
  client: SuiClient,
  wallet: Ed25519Keypair
): Promise<SuiTransactionBlockResponse> {
  const drySign = await signTx(txb, client, wallet, null);

  const dryRun = await client.dryRunTransactionBlock({
    transactionBlock: drySign.bytes,
  });

  handleTxError(dryRun.effects);

  const gasUsed =
    Number(dryRun.effects.gasUsed.computationCost) +
    Number(dryRun.effects.gasUsed.storageCost) -
    Number(dryRun.effects.gasUsed.storageRebate);

  const signedTx = await signTx(txb, client, wallet, Math.max(0, gasUsed));

  const res = await client.executeTransactionBlock({
    transactionBlock: signedTx.bytes,
    signature: signedTx.signature,
    options: { showEffects: true },
  });

  if (!res.effects) {
    throw Error("Tx effects missing");
  }

  handleTxError(res.effects);

  return res;
}

export function signTx(
  txb: TransactionBlock,
  client: SuiClient,
  wallet: Ed25519Keypair,
  gas: number | null
): Promise<SignatureWithBytes> {
  txb.setSender(wallet.toSuiAddress());
  if (gas) {
    txb.setGasBudget(gas);
  }
  return txb.sign({
    client,
    signer: wallet,
  });
}

export function handleTxError(effects: TransactionEffects) {
  if (effects.status.status === "failure") {
    throw Error(
      effects.status.error || `Unknown failure: ${effects.transactionDigest}`
    );
  }
}

export function handleMineralError(effects: TransactionEffects) {
  if (effects.status.status === "failure") {
    const contractErr = extractError(effects.status);
    throw Error(
      contractErr ||
        effects.status.error ||
        `Unknown failure: ${effects.transactionDigest}`
    );
  }
}

export async function launch(
  txb: TransactionBlock,
  client: SuiClient,
  wallet: Ed25519Keypair,
  gas: number
): Promise<SuiTransactionBlockResponse> {
  const signedTx = await signTx(txb, client, wallet, gas);

  const res = await client.executeTransactionBlock({
    transactionBlock: signedTx.bytes,
    signature: signedTx.signature,
    options: { showEffects: true },
  });

  return res;
}

export function buildMineTx(
  client: SuiClient,
  nonce: bigint,
  minerId: string,
  busId: string,
  payer: string,
  coinObject?: string
): TransactionBlock {
  const txb = new TransactionBlock();
  const [createdObj] = mine(txb, {
    nonce,
    bus: txb.sharedObjectRef({
      objectId: busId,
      mutable: true,
      initialSharedVersion: 0,
    }),
    clock: SUI_CLOCK_OBJECT_ID,
    miner: minerId,
  });
  if (coinObject) {
    txb.mergeCoins(coinObject, [createdObj]);
  } else {
    txb.transferObjects([createdObj], payer);
  }
  return txb;
}

export function fakeProof(nonce: bigint): Uint8Array {
  const dataToHash = new Uint8Array(32 + 32 + 8);
  dataToHash.set(int64to8(nonce), 64);
  const bts = keccak_256(dataToHash);
  return new Uint8Array(bts);
}

export function createHash(
  currentHash: Uint8Array,
  signerAddressBytes: Uint8Array,
  nonce: bigint
): Uint8Array {
  const dataToHash = new Uint8Array(32 + 32 + 8);
  dataToHash.set(currentHash, 0);
  dataToHash.set(signerAddressBytes, 32);
  dataToHash.set(int64to8(nonce), 64);
  return keccak_256(dataToHash);
}

export function validateHash(hash: Uint8Array, difficulty: number) {
  return hash.slice(0, difficulty).reduce((a, b) => a + b, 0) === 0;
}

export function int64to8(n: bigint) {
  const arr = BigUint64Array.of(n);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

export async function getProof(
  client: SuiClient,
  address: string
): Promise<string | null> {
  const res = await client.getOwnedObjects({
    owner: address,
    filter: { StructType: Miner.$typeName },
  });
  const [miner] = res.data;
  return miner && miner.data ? miner.data.objectId : null;
}

export async function getOrCreateMiner(
  wallet: Ed25519Keypair,
  client: SuiClient
): Promise<string> {
  const pub = wallet.toSuiAddress();
  const proof = await getProof(client, pub);

  if (proof) {
    return proof;
  }

  const txb = new TransactionBlock();
  register(txb);

  const _res = await estimateGasAndSubmit(txb, client, wallet);

  const miningAccount = await getProof(client, pub);

  if (!miningAccount) {
    throw Error("Miner failed to register");
  }

  return miningAccount;
}

export function extractError(status: ExecutionStatus): string | null {
  const errMsg = status.error;
  if (!errMsg) {
    return null;
  }
  const errs = Object.entries(constants);
  const match = errs.find(([_, code]) => errMsg.includes(code.toString()));
  return match ? match[0] : null;
}

export async function submitProof(
  wallet: Ed25519Keypair,
  client: SuiClient,
  proofData: ProofData,
  bus: Bus
): Promise<SuiTransactionBlockResponse> {
  const txb = buildMineTx(
    client,
    BigInt(proofData.proof.nonce),
    proofData.miner,
    bus.id,
    wallet.toSuiAddress(),
    proofData.coinObject || undefined
  );

  const res = await launch(
    txb,
    client,
    wallet,
    proofData.coinObject ? 1_000_000 : 2_500_000
  );

  if (!res.effects) {
    throw Error("Tx effects missing");
  }
  handleMineralError(res.effects);

  await waitUntilNextHash(client, proofData.miner, proofData.proof.currentHash);

  return res;
}

export interface MineConfig {
  currentHash: Uint8Array;
  signer: Uint8Array;
  difficulty: number;
  initialNonce: bigint;
}

export interface MineResult {
  currentHash: Uint8Array;
  proof: Uint8Array;
  nonce: bigint;
}

export function snooze(n: number) {
  return new Promise((r) => setTimeout(() => r(true), n));
}

export async function waitUntilNextEpoch(client: SuiClient) {
  const bus = await fetchBus(client);
  const lastReset = bus.lastReset;
  const nextReset = Number(bus.lastReset) + constants.EPOCH_LENGTH;
  const timeUntilNextReset = nextReset - Date.now();
  if (timeUntilNextReset > 0) {
    await snooze(timeUntilNextReset);
  }
  while (true) {
    const freshBus = await fetchBus(client);
    if (freshBus.lastReset !== lastReset) {
      break;
    } else {
      await snooze(1500);
    }
  }
}

export async function waitUntilNextHash(
  client: SuiClient,
  miner: string,
  currentHash: number[]
) {
  let current = currentHash.join();
  let attempts = 0;
  while (attempts < 5) {
    const minerObj = await Miner.fetch(client, miner);
    if (minerObj.currentHash.join() !== current) {
      return;
    } else {
      attempts += 1;
      await snooze(2000);
    }
  }
  throw Error("Failed to acquire new hash");
}
