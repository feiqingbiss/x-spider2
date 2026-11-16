import { Child, Command } from '@tauri-apps/api/shell';
import { EventEmitter } from './event';
import * as R from 'ramda';

export enum AriaStatus {
  Waiting = 'waiting',
  Active = 'active',
  Paused = 'paused',
  Error = 'error',
  Complete = 'complete',
  Removed = 'removed',
}

export type AriaResult = any;
export interface AriaTask {
  gid: AriaGid;
  status: AriaStatus;
  [key: string]: any;
}

export type AriaGid = string;

class Aria2 {
  #ready = false;
  get ready() { return this.#ready; }
  #secret = crypto.randomUUID();
  #port = 6801;
  #ws?: WebSocket;
  #command?: Command;
  #child?: Child;
  #invokeId = 0;
  #globalOptions: Record<string, string> = {};
  #callbackMap = new Map<number, (data: any) => void>();
  
  #isReconnecting = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0; // ✅ 新增重连次数记录

  get #tokenParam() {
    return `token:${this.#secret}`;
  }

  #onBeforeUnload = this.#_onBeforeUnload.bind(this);
  #onStderr = this.#_onStderr.bind(this);
  #onWsMessage = this.#_onWsMessage.bind(this);
  #onWsClose = this.#_onWsClose.bind(this);

  onReady = new EventEmitter();
  onDownloadStart = new EventEmitter<string>();
  onDownloadPause = new EventEmitter<string>();
  onDownloadStop = new EventEmitter<string>();
  onDownloadComplete = new EventEmitter<string>();
  onDownloadError = new EventEmitter<string>();
  #log?: ICategoriedLogger;

  async bootstrap() {
    if (this.#ready) throw new Error('Aria2 is already ready');

    this.#log = log.category('ARIA');
    const args = [
      '--enable-rpc',
      '--rpc-secret',
      this.#secret,
      '--rpc-listen-port',
      this.#port.toString(),
      '--check-certificate=false', 
      '--auto-save-interval=30',
      '--retry-wait=10',
      '--max-tries=5',
    ];
    this.#command = Command.sidecar('binaries/aria2c', args);
    this.#log.info('Spawn with args:', args);
    this.#child = await this.#command.spawn();
    this.#log?.info('Wait for listening...');
    await new Promise((resolve, reject) => {
      const onStdout = (message: string) => {
        if (!this.ready && message.includes('IPv4 RPC: listening on TCP port')) {
          this.#log?.info('Child process launched');
          this.#command!.stdout.removeListener('data', onStdout);
          this.#command!.stdout.removeListener('data', onStderr);
          resolve(null);
        }
      };
      const onStderr = (message: string) => {
        this.#command!.stdout.removeListener('data', onStdout);
        this.#command!.stdout.removeListener('data', onStderr);
        reject(new Error(message));
      };
      this.#command!.stdout.on('data', onStdout);
      this.#command!.stderr.on('data', onStderr);
    });

    await this.#connectWs();

    window.addEventListener('beforeunload', this.#onBeforeUnload);
    this.#command.stderr.on('data', this.#onStderr);
  }

  async #connectWs() {
    this.#log?.info('Connecting websocket...');
    this.#ws = new WebSocket(`ws://127.0.0.1:${this.#port}/jsonrpc`);
    
    await new Promise((resolve, reject) => {
      const onError = (ev: any) => {
        this.#log?.error('Failed to connect websocket', ev);
        reject(new Error('Failed to connect websocket'));
      };
      this.#ws!.addEventListener(
        'open',
        () => {
          this.#log?.info('Websocket connected');
          this.#ready = true;
          const wasReconnecting = this.#isReconnecting;
          this.#isReconnecting = false;
          this.#reconnectAttempts = 0;
          this.#ws!.removeEventListener('error', onError);
          resolve(null);
          // ✅ 修复：使用 wasReconnecting 避免前面的重置导致判断失效
          if (wasReconnecting) this.onReady.emit();
        },
        { once: true },
      );
      this.#ws!.addEventListener('error', onError, { once: true });
      this.#ws!.addEventListener('message', this.#onWsMessage);
      this.#ws!.addEventListener('close', this.#onWsClose);
    });
  }

  async #_onWsClose() {
    this.#ready = false;
    this.#log?.warn('Websocket closed. Pending callbacks will be flushed.');
    
    this.#callbackMap.forEach((fn) => fn({ error: { message: 'Websocket disconnected' } }));
    this.#callbackMap.clear();

    if (this.#isReconnecting) return;
    this.#isReconnecting = true;
    this.#reconnectAttempts++;

    // ✅ 修复：加入指数退避，最多等待 30 秒
    const delay = Math.min(1000 * Math.pow(2, this.#reconnectAttempts), 30000);
    this.#log?.info(`Scheduling WebSocket reconnect in ${delay / 1000}s...`);
    
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(async () => {
      try {
        await this.#connectWs();
      } catch (e) {
        this.#log?.error('Reconnect failed, will retry via onclose', e);
        this.#isReconnecting = false;
        this.#_onWsClose(); 
      }
    }, delay);
  }

  #_onBeforeUnload() {
    this.#log?.info('Window before unload');
    this.#ws!.close();
    this.#child!.kill();
  }

  #_onStderr(message: string) {
    this.#log?.error('Stderr', message);
  }

  async #_onWsMessage(ev: MessageEvent) {
    let data: any;
    try {
      data = JSON.parse(ev.data);
    } catch (err) {
      this.#log?.error('Parse json error:', ev.data, err);
      return;
    }

    if (data.id) {
      const id = Number(data.id);
      const fn = this.#callbackMap.get(id);
      if (fn) {
        fn(data);
        this.#callbackMap.delete(id);
      }
    } else if (data.method) {
      const gid: string = data.params[0].gid;
      await this.#onAriaEvent(data.method, gid);
    }
  }

  async #onAriaEvent(method: string, gid: string) {
    switch (method) {
      case 'aria2.onDownloadStart': this.onDownloadStart.emit(gid); break;
      case 'aria2.onDownloadPause': this.onDownloadPause.emit(gid); break;
      case 'aria2.onDownloadStop': this.onDownloadStop.emit(gid); break;
      case 'aria2.onDownloadComplete': this.onDownloadComplete.emit(gid); break;
      case 'aria2.onDownloadError': this.onDownloadError.emit(gid); break;
    }
  }

  async #updateGlobalOptions(options: Record<string, string>) {
    this.#globalOptions = options;
    await this.invoke('aria2.changeGlobalOption', this.#globalOptions);
  }

  ensureReady() {
    if (!this.ready) throw new Error('Aria2 is not ready yet');
  }

  async updateProxy(proxyUrl: string) {
    await this.#updateGlobalOptions({
      ...this.#globalOptions,
      'all-proxy': proxyUrl,
    });
  }

  async #invoke(method: string, params: any[]): Promise<AriaResult | AriaResult[]> {
    this.ensureReady();
    return new Promise((resolve, reject) => {
      const id = this.#invokeId++;
      const payload = { jsonrpc: '2.0', id: id.toString(), method, params };
      this.#ws!.send(JSON.stringify(payload));

      this.#callbackMap.set(id, (data: any) => {
        if (data.error) {
          reject(new Error(`Aria2 调用 ${method} 失败：${data.error.message}`));
          return;
        }
        resolve(data.result);
      });
    });
  }

  async invoke(method: string, ...args: any[]): Promise<AriaResult> {
    return this.#invoke(method, [this.#tokenParam, ...args]);
  }

  async batchInvoke(payload: { methodName: string; params: any[] }[]): Promise<AriaResult[]> {
    return (await this.#invoke('system.multicall', [
      payload.map((item) => ({ methodName: item.methodName, params: [this.#tokenParam, ...item.params] })),
    ])) as AriaResult[];
  }

  async tellStatus(gid: AriaGid): Promise<AriaTask>;
  async tellStatus(gid: AriaGid[]): Promise<Record<AriaGid, AriaTask>>;
  async tellStatus(gid: AriaGid | AriaGid[]) {
    if (!Array.isArray(gid)) return this.invoke('aria2.tellStatus', gid);

    const results = await this.batchInvoke(
      gid.map((id) => ({ methodName: 'aria2.tellStatus', params: [id] })),
    );

    const resultMap = R.pipe(
      R.flatten,
      R.map<any, [string, any]>((r: AriaTask) => [r.gid, r]),
      R.fromPairs,
    )(results);

    return resultMap;
  }
}

export const aria2 = new Aria2();