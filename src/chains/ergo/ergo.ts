import {
  NetworkPrefix,
  SecretKey,
  SecretKeys,
  Wallet,
} from 'ergo-lib-wasm-nodejs';
import LRUCache from 'lru-cache';
import { ErgoController } from './ergo.controller';
import { NodeService } from './node.service';
import { getErgoConfig } from './ergo.config';
import { DexService } from './dex.service';
import { Account, BoxType, ErgoAsset } from './ergo.interface';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export class Ergo {
  private _assetMap: Record<string, ErgoAsset> = {};
  private static _instances: LRUCache<string, Ergo>;
  private _chain: string = 'ergo';
  private _network: string;
  private _networkPrefix: NetworkPrefix;
  private _node: NodeService;
  private _dex: DexService;
  private _ready: boolean = false;
  public txFee: number;
  public controller: typeof ErgoController;
  private utxosLimit: number;

  constructor(network: string, nodeUrl: string) {
    this._network = network;
    const config = getErgoConfig(network);
    if (network === 'Mainnet') this._networkPrefix = NetworkPrefix.Mainnet;
    else this._networkPrefix = NetworkPrefix.Testnet;
    this._node = new NodeService(nodeUrl, config.network.timeOut);
    this._dex = new DexService(nodeUrl, config.network.timeOut);
    this.controller = ErgoController;
    this.txFee = config.network.minTxFee;
    this.utxosLimit = config.network.utxosLimit;
  }

  public get node(): NodeService {
    return this._node;
  }

  public get network(): string {
    return this._network;
  }

  public get storedAssetList(): ErgoAsset[] {
    return Object.values(this._assetMap);
  }

  public ready(): boolean {
    return this._ready;
  }

  public async init(): Promise<void> {
    await this.loadAssets();
    this._ready = true;
    return;
  }

  async close() {
    return;
  }

  public static getInstance(network: string): Ergo {
    const config = getErgoConfig(network);
    if (Ergo._instances === undefined) {
      Ergo._instances = new LRUCache<string, Ergo>({
        max: config.network.maxLRUCacheInstances,
      });
    }

    if (!Ergo._instances.has(config.network.name)) {
      if (network !== null) {
        const nodeUrl = config.network.nodeURL;
        Ergo._instances.set(config.network.name, new Ergo(network, nodeUrl));
      } else {
        throw new Error(
          `Ergo.getInstance received an unexpected network: ${network}.`,
        );
      }
    }

    return Ergo._instances.get(config.network.name) as Ergo;
  }

  public static getConnectedInstances(): { [name: string]: Ergo } {
    const connectedInstances: { [name: string]: Ergo } = {};
    if (this._instances !== undefined) {
      const keys = Array.from(this._instances.keys());
      for (const instance of keys) {
        if (instance !== undefined) {
          connectedInstances[instance] = this._instances.get(instance) as Ergo;
        }
      }
    }
    return connectedInstances;
  }

  async getCurrentBlockNumber(): Promise<number> {
    const status = await this._node.getNetworkHeight();
    return status + 1;
  }

  async getAddressUnSpentBoxes(address: string) {
    let utxos: BoxType[] = [];
    let offset = 0;
    let nodeBoxes: BoxType[] = await this._node.getUnSpentBoxesByAddress(
      address,
      offset,
      this.utxosLimit,
    );
    while (nodeBoxes.length > 0) {
      utxos = [...utxos, ...nodeBoxes];
      offset += this.utxosLimit;
      nodeBoxes = await this._node.getUnSpentBoxesByAddress(
        address,
        offset,
        this.utxosLimit,
      );
    }
    return utxos;
  }
  public getAccountFromSecretKey(secret: string): Account {
    const secretKey = SecretKey.dlog_from_bytes(Buffer.from(secret, 'hex'));
    const address = secretKey.get_address().to_base58(this._networkPrefix);
    const sks = new SecretKeys();
    sks.add(secretKey);
    const wallet = Wallet.from_secrets(sks);
    return {
      address,
      wallet,
    };
  }

  public encrypt(secret: string, password: string): string {
    const iv = randomBytes(16);
    const key = Buffer.alloc(32);
    key.write(password);

    const cipher = createCipheriv('aes-256-cbc', key, iv);

    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  public decrypt(encryptedSecret: string, password: string): string {
    const [iv, encryptedKey] = encryptedSecret.split(':');
    const key = Buffer.alloc(32);
    key.write(password);

    const decipher = createDecipheriv(
      'aes-256-cbc',
      key,
      Buffer.from(iv, 'hex'),
    );

    const decrpyted = Buffer.concat([
      decipher.update(Buffer.from(encryptedKey, 'hex')),
      decipher.final(),
    ]);

    return decrpyted.toString();
  }

  public async getAssetBalance(
    account: Account,
    assetName: string,
  ): Promise<string> {
    const ergoAsset = this._assetMap[assetName];
    let balance = 0;
    try {
      const utxos = await this.getAddressUnSpentBoxes(account.address);
      balance = utxos.reduce(
        (total: number, box) =>
          total +
          box.assets
            .filter((asset) => asset.tokenId === ergoAsset.tokenId)
            .reduce(
              (total_asset, asset) => total_asset + Number(asset.amount),
              0,
            ),
        0,
      );
    } catch (error: any) {
      throw new Error(
        `problem during finding account assets ${this._chain} Node!`,
      );
    }
    const amount = balance;
    return amount.toString();
  }

  private async loadAssets(): Promise<void> {
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

  private async getAssetData(): Promise<any> {
    return await this._dex.getTokens();
  }

  public get storedTokenList() {
    return this._assetMap;
  }
}