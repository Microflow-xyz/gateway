import {
  NetworkPrefix,
  SecretKey,
  SecretKeys,
  Wallet,
  Mnemonic,
  ExtSecretKey,
  DerivationPath,
} from 'ergo-lib-wasm-nodejs';
import LRUCache from 'lru-cache';
import { ErgoController } from './ergo.controller';
import { NodeService } from './node.service';
import { getErgoConfig } from './ergo.config';
import { DexService } from './dex.service';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  ErgoAccount,
  ErgoAsset,
  ErgoBox,
  ErgoConnectedInstance,
} from './interfaces/ergo.interface';
import {
  AmmPool,
  makeNativePools,
  makeWrappedNativePoolActionsSelector,
  SwapExtremums,
  SwapParams,
  swapVars,
} from '@patternglobal/ergo-dex-sdk';
import {
  Explorer,
  ErgoTx,
  DefaultTxAssembler,
  AssetAmount,
  publicKeyFromAddress,
  TransactionContext,
  RustModule,
} from '@patternglobal/ergo-sdk';
import { NativeExFeeType } from '@patternglobal/ergo-dex-sdk/build/main/types';
import { NetworkContext } from '@patternglobal/ergo-sdk/build/main/entities/networkContext';
import { ErgoNetwork } from './types/ergo.type';
import { getBaseInputParameters, getInputs, getTxContext } from './ergo.util';
import { WalletProver } from './wallet-prover.service';
import { BigNumber } from 'bignumber.js';
import { PriceResponse, TradeResponse } from '../../amm/amm.requests';

class Pool extends AmmPool {
  private _name: string;

  constructor(public pool: AmmPool) {
    super(pool.id, pool.lp, pool.x, pool.y, pool.poolFeeNum);

    this._name = `${this.pool.x.asset.name}/${this.pool.y.asset.name}`;
  }

  public get name() {
    return this._name;
  }

  public get info() {
    return {
      id: this.id,
      lp: this.lp,
      x: this.x,
      y: this.y,
      feeNum: this.feeNum,
      feeDenom: this.feeDenom,
    };
  }
}

export class Ergo {
  private _assetMap: Record<string, ErgoAsset> = {};
  private static _instances: LRUCache<string, Ergo>;
  private _chain: string = 'ergo';
  private _network: ErgoNetwork;
  private _networkPrefix: NetworkPrefix;
  private _node: NodeService;
  private _explorer: Explorer;
  private _dex: DexService;
  private _ready: boolean = false;
  public txFee: number;
  public controller: ErgoController;
  private utxosLimit: number;
  private poolLimit: number;
  private ammPools: Array<Pool> = [];

  constructor(network: ErgoNetwork) {
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('network should be `mainnet` or `testnet`');
    }

    const config = getErgoConfig(network);

    this._networkPrefix = config.network.networkPrefix;
    this._network = network;
    this._node = new NodeService(
      config.network.nodeURL,
      config.network.timeOut,
    );
    this._explorer = new Explorer(config.network.explorerURL);
    this._dex = new DexService(
      config.network.explorerDEXURL,
      config.network.timeOut,
    );
    this.controller = ErgoController;
    this.txFee = config.network.minTxFee;
    this.utxosLimit = config.network.utxosLimit;
    this.poolLimit = config.network.poolLimit;
  }

  public get node(): NodeService {
    return this._node;
  }

  public get network(): ErgoNetwork {
    return this._network;
  }

  public get storedAssetList(): Array<ErgoAsset> {
    return Object.values(this._assetMap);
  }

  public ready(): boolean {
    return this._ready;
  }

  public async getNetworkHeight() {
    return await this._node.getNetworkHeight();
  }

  /**
   * This function initializes the Ergo class' instance
   * @returns
   * @function
   * @async
   */
  public async init(): Promise<void> {
    await RustModule.load(true);
    await this.loadAssets();
    await this.loadPools();
    this._ready = true;
    return;
  }

  async close() {
    return;
  }

  /**
   * This static function returns the exists or create new Ergo class' instance based on the network
   * @param {string} network - mainnet or testnet
   * @returns Ergo
   * @function
   * @static
   */
  public static getInstance(network: ErgoNetwork): Ergo {
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('network should be `mainnet` or `testnet`');
    }

    const config = getErgoConfig(network);

    if (!Ergo._instances) {
      Ergo._instances = new LRUCache<string, Ergo>({
        max: config.network.maxLRUCacheInstances,
      });
    }

    if (!Ergo._instances.has(config.network.name)) {
      if (network) {
        Ergo._instances.set(config.network.name, new Ergo(network));
      } else {
        throw new Error(
          `Ergo.getInstance received an unexpected network: ${network}.`,
        );
      }
    }

    return Ergo._instances.get(config.network.name) as Ergo;
  }

  /**
   * This static function returns the connected instances
   * @returns ErgoConnectedInstance
   * @function
   * @static
   */
  public static getConnectedInstances(): ErgoConnectedInstance {
    const connectedInstances: ErgoConnectedInstance = {};

    if (this._instances) {
      const keys = Array.from(this._instances.keys());

      for (const instance of keys) {
        if (instance) {
          connectedInstances[instance] = this._instances.get(instance) as Ergo;
        }
      }
    }

    return connectedInstances;
  }

  /**
   * This function returns the current network height(Block number)
   * @returns number
   * @function
   * @async
   */
  async getCurrentBlockNumber(): Promise<number> {
    const status = await this._node.getNetworkHeight();
    return status + 1;
  }

  /**
   * This function returns the unspent boxes based on the address from node
   * @returns ErgoBox[]
   * @function
   * @async
   */
  async getAddressUnspentBoxes(address: string) {
    let utxos: Array<ErgoBox> = [];
    let offset = 0;
    let nodeBoxes = await this._node.getUnspentBoxesByAddress(
      address,
      offset,
      this.utxosLimit,
    );

    while (nodeBoxes.length > 0) {
      utxos = [...utxos, ...nodeBoxes];
      offset += this.utxosLimit;
      nodeBoxes = await this._node.getUnspentBoxesByAddress(
        address,
        offset,
        this.utxosLimit,
      );
    }

    return utxos;
  }

  /**
   * Retrieves Ergo Account from secret key
   * @param {string} secret - Secret key
   * @returns ErgoAccount
   * @function
   */
  public getAccountFromSecretKey(secret: string): ErgoAccount {
    const sks = new SecretKeys();
    const secretKey = SecretKey.dlog_from_bytes(Buffer.from(secret, 'hex'));
    const address = secretKey.get_address().to_base58(this._networkPrefix);

    sks.add(secretKey);

    const wallet = Wallet.from_secrets(sks);

    return {
      address,
      wallet,
      prover: new WalletProver(wallet, this._node),
    };
  }

  /**
   * Retrieves Ergo Account from mnemonic
   * @param {string} mnemonic - Mnemonic
   * @returns ErgoAccount
   * @function
   */
  public getAccountFromMnemonic(mnemonic: string): ErgoAccount {
    const sks = new SecretKeys();
    const seed = Mnemonic.to_seed(mnemonic, '');
    const rootSecret = ExtSecretKey.derive_master(seed);
    const changePath = DerivationPath.new(0, new Uint32Array([0]));
    const secretKeyBytes = rootSecret.derive(changePath).secret_key_bytes();
    const secretKey = SecretKey.dlog_from_bytes(secretKeyBytes);
    const address = secretKey.get_address().to_base58(this._networkPrefix);

    sks.add(secretKey);

    const wallet = Wallet.from_secrets(sks);

    return {
      address,
      wallet,
      prover: new WalletProver(wallet, this._node),
    };
  }

  /**
   * Encrypt secret via password
   * @param {string} secret - Secret key
   * @param {string} password - password
   * @returns string
   * @function
   */
  public encrypt(secret: string, password: string): string {
    const iv = randomBytes(16);
    const key = Buffer.alloc(32);

    key.write(password);

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt encrypted secret key via password
   * @param {string} encryptedSecret - Secret key
   * @param {string} password - password
   * @returns string
   * @function
   */
  public decrypt(encryptedSecret: string, password: string): string {
    const [iv, encryptedKey] = encryptedSecret.split(':');
    const key = Buffer.alloc(32);

    key.write(password);

    const decipher = createDecipheriv(
      'aes-256-cbc',
      key,
      Buffer.from(iv, 'hex'),
    );
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedKey, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString();
  }

  /**
   *  Gets asset balance from unspent boxes
   * @param {ErgoAccount} account
   * @param {string} assetName
   * @returns string
   * @function
   * @async
   */
  public async getAssetBalance(
    account: ErgoAccount,
    assetName: string,
  ): Promise<string> {
    const ergoAsset = this._assetMap[assetName.toUpperCase()];
    let balance = BigNumber(0);
    if (!ergoAsset) throw new Error(`assetName not found ${this._chain} Node!`);
    try {
      const utxos = await this.getAddressUnspentBoxes(account.address);
      balance = utxos.reduce(
        (total: BigNumber, box) =>
          total.plus(
            box.assets
              .filter((asset) => asset.tokenId === ergoAsset.tokenId.toString())
              .reduce(
                (total_asset, asset) =>
                  total_asset.plus(BigNumber(asset.amount)),
                BigNumber(0),
              ),
          ),
        BigNumber(0),
      );
    } catch (error: any) {
      throw new Error(
        `problem during finding account assets ${this._chain} Node!`,
      );
    }

    return balance.toString();
  }

  public getBalance(utxos: ErgoBox[]) {
    const balance = utxos.reduce(
      (total, box) => total.plus(BigNumber(box.value)),
      BigNumber(0),
    );
    const assets: Record<string, BigNumber> = {};

    utxos.forEach((box) => {
      box.assets.forEach((asset) => {
        if (Object.keys(assets).includes(asset.tokenId))
          assets[asset.tokenId] = assets[asset.tokenId].plus(
            BigNumber(asset.amount),
          );
        else assets[asset.tokenId] = BigNumber(asset.amount);
      });
    });

    return { balance, assets };
  }

  private async loadAssets() {
    const assetData = await this.getAssetData();

    for (const result of assetData.tokens) {
      this._assetMap[result.name.toUpperCase()] = {
        tokenId: result.address,
        decimals: result.decimals,
        name: result.name,
        symbol: result.ticker,
      };
    }
  }

  private async getAssetData() {
    return await this._dex.getTokens();
  }

  private async loadPools(): Promise<void> {
    let offset = 0;
    let pools: Array<Pool> = await this.getPoolData(this.poolLimit, offset);

    while (pools.length > 0) {
      for (const pool of pools) {
        if (!this.ammPools.filter((ammPool) => ammPool.id === pool.id).length) {
          this.ammPools.push(pool);
        }
      }

      offset += this.poolLimit;
      pools = await this.getPoolData(this.poolLimit, offset);
    }
  }

  public async loadPool(poolId: string): Promise<void> {
    await RustModule.load(true);
    const pool = await this.getPool(poolId);

    if (!pool) {
      const new_pool = await makeNativePools(this._explorer).get(poolId);
      if (!new_pool)
        throw new Error(`can not get pool with this id: ${poolId}`);
      this.ammPools.push(new Pool(new_pool));
    }
  }

  private async getPoolData(limit: number, offset: number): Promise<any> {
    const [AmmPool] = await makeNativePools(this._explorer).getAll({
      limit,
      offset,
    });

    return AmmPool;
  }

  /**
   *  Returns a map of asset name and Ergo Asset
   * @returns assetMap
   */
  public get storedTokenList() {
    return this._assetMap;
  }

  public async swap(
    account: ErgoAccount,
    baseToken: string,
    quoteToken: string,
    amount: BigNumber,
    output_address: string,
    return_address: string,
    slippage?: number,
  ): Promise<TradeResponse> {
    let sell: boolean;
    const pool = this.getPoolByToken(baseToken, quoteToken);
    if (!pool)
      throw new Error(`pool not found base on ${baseToken}, ${quoteToken}`);
    if (pool.x.asset.id === baseToken) sell = false;
    else sell = true;
    const config = getErgoConfig(this.network);
    const networkContext = await this._explorer.getNetworkContext();
    const mainnetTxAssembler = new DefaultTxAssembler(
      this.network === 'mainnet',
    );
    const poolActions = makeWrappedNativePoolActionsSelector(
      output_address,
      account.prover,
      mainnetTxAssembler,
    );
    const utxos = await this.getAddressUnspentBoxes(account.address);
    const to = {
      asset: {
        id: sell ? pool.x.asset.id : pool.y.asset.id,
        decimals: sell ? pool.x.asset.decimals : pool.y.asset.decimals,
      },
      amount: amount,
    };
    const max_to = {
      asset: {
        id: sell ? pool.x.asset.id : pool.y.asset.id,
      },
      amount: amount,
    };
    const from = {
      asset: {
        id: sell ? pool.y.asset.id : pool.x.asset.id,
        decimals: sell ? pool.y.asset.decimals : pool.x.asset.decimals,
      },
      amount: pool.outputAmount(
        max_to as any,
        slippage || config.network.defaultSlippage,
      ).amount,
    };
    if (from.amount === BigInt(0))
      throw new Error(`${amount} asset from ${max_to.asset.id} is not enough!`);
    const { baseInput, baseInputAmount, minOutput } = getBaseInputParameters(
      pool,
      {
        inputAmount: from,
        slippage: slippage || config.network.defaultSlippage,
      },
    );
    const swapVariables: [number, SwapExtremums] | undefined = swapVars(
      BigInt(config.network.defaultMinerFee.multipliedBy(3).toString()),
      config.network.minNitro,
      minOutput,
    );
    if (!swapVariables) throw new Error('error in swap vars!');
    const [exFeePerToken, extremum] = swapVariables;
    const inputs = getInputs(
      utxos.map((utxo) => {
        const temp = Object(utxo);
        temp.value = BigNumber(temp.value);
        temp.assets = temp.assets.map((asset: any) => {
          const temp2 = Object(asset);
          temp2.amount = BigNumber(temp2.amount);
          return temp2;
        });
        return temp;
      }),
      [new AssetAmount(from.asset, BigInt(baseInputAmount.toString()))],
      {
        minerFee: BigInt(config.network.defaultMinerFee.toString()),
        uiFee: BigInt(config.network.defaultMinerFee.toString()),
        exFee: BigInt(extremum.maxExFee.toString()),
      },
    );
    const pk = publicKeyFromAddress(output_address);
    if (!pk) throw new Error(`output_address is not defined.`);
    const swapParams: SwapParams<NativeExFeeType> = {
      poolId: pool.id,
      pk,
      baseInput,
      minQuoteOutput: extremum.minOutput.amount,
      exFeePerToken,
      uiFee: BigInt(config.network.defaultMinerFee.toString()),
      quoteAsset: to.asset.id,
      poolFeeNum: pool.poolFeeNum,
      maxExFee: extremum.maxExFee,
    };
    const txContext: TransactionContext = getTxContext(
      inputs,
      networkContext as NetworkContext,
      return_address,
      BigInt(config.network.defaultMinerFee.toString()),
    );
    const actions = poolActions(pool);
    const timestamp = (
      await this._node.getBlockInfo(networkContext.height.toString())
    ).header.timestamp;
    const tx = await actions.swap(swapParams, txContext);
    return {
      network: this.network,
      timestamp,
      latency: 0,
      base: baseToken,
      quote: quoteToken,
      amount: amount.toString(),
      rawAmount: amount.toString(),
      expectedOut: minOutput.amount.toString(),
      price: sell
        ? pool.priceX.numerator.toString()
        : pool.priceY.numerator.toString(), // Cosmos: finalPrice
      gasPrice: 0,
      gasPriceToken: '0',
      gasLimit: 0,
      gasCost: '0',
      txHash: tx.id,
    };
  }

  public async estimate(
    baseToken: string,
    quoteToken: string,
    amount: BigNumber,
    slippage?: number,
  ): Promise<PriceResponse> {
    let sell: boolean;
    const pool = this.getPoolByToken(baseToken, quoteToken);
    if (!pool)
      throw new Error(`pool not found base on ${baseToken}, ${quoteToken}`);
    if (pool.x.asset.id === baseToken) sell = false;
    else sell = true;
    const config = getErgoConfig(this.network);
    const max_to = {
      asset: {
        id: sell ? pool.x.asset.id : pool.y.asset.id,
      },
      amount,
    };
    const from = {
      asset: {
        id: sell ? pool.y.asset.id : pool.x.asset.id,
        decimals: sell ? pool.y.asset.decimals : pool.x.asset.decimals,
      },
      amount: pool.outputAmount(
        max_to as any,
        slippage || config.network.defaultSlippage,
      ).amount,
    };
    const { minOutput } = getBaseInputParameters(pool, {
      inputAmount: from,
      slippage: slippage || config.network.defaultSlippage,
    });
    return {
      base: baseToken,
      quote: quoteToken,
      amount: amount.toString(),
      rawAmount: amount.toString(),
      expectedAmount: minOutput.amount.toString(),
      price: sell
        ? pool.priceX.numerator.toString()
        : pool.priceY.numerator.toString(),
      network: this.network,
      timestamp: Date.now(),
      latency: 0,
      gasPrice: 0,
      gasPriceToken: '0',
      gasLimit: 0,
      gasCost: '0',
    };
  }

  public getPool(id: string): Pool {
    return <Pool>this.ammPools.find((ammPool) => ammPool.id === id);
  }

  public getPoolByToken(baseToken: string, quoteToken: string): Pool {
    return <Pool>(
      this.ammPools.find(
        (ammPool) =>
          (ammPool.x.asset.id === baseToken &&
            ammPool.y.asset.id === quoteToken) ||
          (ammPool.x.asset.id === quoteToken &&
            ammPool.y.asset.id === baseToken),
      )
    );
  }

  public async getTx(id: string): Promise<ErgoTx> {
    return await this._node.getTxsById(id);
  }
}
