import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * VS Code 扩展端「局域网联机桥接」公共模块。
 *
 * 设计前提：游戏的 webview 只通过 acquireVsCodeApi() 与扩展通信、从不自己开 socket，
 * 因此整个网络层（host WebSocketServer / client WebSocket、peer 管理、广播单播、
 * webview↔网络中转、命令注册、清理）都可收敛在本模块内，由消费项目直接复用。
 *
 * 用法见 README.md。最小集成只需提供 buildBootstrap 与 webviewHtmlPath，
 * 其余（命令、socket 生命周期、超时、清理）均由本模块托管。模块使用一套固定
 * 规范生命周期词汇（见 EVT），三项目 webview 统一对齐，无需任何按项目配置。
 */

/** 在网络 / webview 之间流转的消息。模块只认三个保留字段，其余由游戏自定义。 */
export type MultiMessage = Record<string, unknown> & {
  /** 业务消息类型，游戏自定义（如 'startGame' / 'boardSync'）。 */
  type?: string;
  /** 单播目标 peerId（p1/p2…），仅 host 侧生效。 */
  to?: string;
  /** 由 host 在 peer→webview 时自动注入，标记来源 peerId，业务只读。 */
  from?: string;
};

/** 传给 buildBootstrap 的参数，用于构造注入 HTML 的对象。 */
export interface BootstrapParams {
  role: 'host' | 'client';
  /** host 模式=本机 IPv4；client 模式=用户填写的连接地址。 */
  host: string;
  port: number;
  /** 本机首个非内部 IPv4，回退 127.0.0.1。 */
  localIp: string;
}

/** 传给 onWebviewMessage 钩子的 API，供项目绕开默认转发手动收发。 */
export interface WebviewMessageApi {
  role: 'host' | 'client';
  /** 当前已连 peerId 列表（host 侧）。 */
  peers(): string[];
  /** host 侧：广播给所有 peer。 */
  broadcast(msg: MultiMessage): void;
  /** host 侧：单播给指定 peerId。 */
  sendTo(peerId: string, msg: MultiMessage): void;
}

/** peer 进出事件。 */
export interface PeerChangeEvent {
  kind: 'join' | 'leave';
  peerId: string;
  /** 当前全部 peerId（含本次变化后）。 */
  peers: string[];
}

/** 可选文案钩子，全部缺省时给中文兜底，不耦合任何项目 i18n 体系。 */
export interface MultiI18n {
  roomCreated?: (ip: string, port: number) => string;
  portInUse?: (port: number) => string;
  connectFailed?: (err: string) => string;
  connectTimeout?: (ms: number) => string;
  joinPrompt?: () => string;
  invalidAddress?: (raw: string) => string;
}

/**
 * 模块硬编码的规范生命周期消息 type。三项目 webview 统一监听这些名字，
 * 不给任何按项目配置（webview 词汇不同就改 webview，让模块保持单一契约）。
 * peer 进/出的载荷只带 `from`（=peerId）与 `peers`，不再带 `id`，不再发 peerChange。
 */
export const EVT = {
  hostReady: 'hostReady',
  hostError: 'hostError',
  peerConnected: 'peerConnected',
  peerDisconnected: 'peerDisconnected',
  clientConnected: 'clientConnected',
  clientDisconnected: 'clientDisconnected',
  clientTimeout: 'clientTimeout',
  clientRefused: 'clientRefused',
  clientError: 'clientError',
} as const;

/** 规范生命周期消息 type 的字面量联合类型。 */
export type MultiLifecycleType = (typeof EVT)[keyof typeof EVT];

export interface LanMultiplayerOptions {
  context: vscode.ExtensionContext;
  /** 命令前缀，如 'tetris' | 'minesweeper' | 'battlePlane'。 */
  commandPrefix: string;
  /** host 面板 viewType。 */
  viewTypeHost: string;
  /** client 面板 viewType。 */
  viewTypeClient: string;
  /** host 监听端口，可为常量或函数（如读取配置项）。 */
  port: number | (() => number);
  /** 最大 peer 数，默认 Infinity；设为 1 即 1v1，超员连接将被关闭。 */
  maxPeers?: number;
  /** HTML 中 bootstrap 占位符，默认 '__MULTI_BOOTSTRAP_VALUE__'。 */
  bootstrapHtmlToken?: string;
  /** 返回 multi html 在扩展内的路径。 */
  webviewHtmlPath: (ctx: vscode.ExtensionContext) => vscode.Uri;
  /**
   * webview 可加载的本地资源根目录。缺省取 webviewHtmlPath 的父目录（即 html 所在目录）。
   * 若 html 引用的资源分散在更上层目录，可在此覆盖（如扩展根 + 'src'）。
   */
  localResourceRoots?: (ctx: vscode.ExtensionContext) => vscode.Uri[];
  /** 根据运行参数构造注入 HTML 的对象（如 { role, host, port } 或含 dict）。 */
  buildBootstrap: (p: BootstrapParams) => object;
  /** client 连接超时（毫秒），默认 10000。 */
  connectTimeoutMs?: number;
  i18n?: MultiI18n;
  /**
   * webview 消息拦截钩子。返回 true 表示消息已被项目消费，模块不再自动转发网络
   * （用于 setNickname / rename 等本地处理）。
   */
  onWebviewMessage?: (msg: MultiMessage, api: WebviewMessageApi) => boolean | void;
  /** peer 进出回调，用于驱动游戏逻辑（如更新人数）。 */
  onPeerChange?: (ev: PeerChangeEvent) => void;
}

export const DEFAULT_BOOTSTRAP_TOKEN = '__MULTI_BOOTSTRAP_VALUE__';
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_PEERS = Infinity;

/** 取本机首个非内部 IPv4，回退 127.0.0.1。 */
export function getLocalIPv4(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) {
      continue;
    }
    for (const addr of list) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

interface PeerEntry {
  ws: WebSocket;
  id: string;
}

/**
 * 局域网联机桥接器：左侧接 WebviewPanel（游戏 UI），右侧接 ws 网络对端
 * （host 为 WebSocketServer + 多 peer，client 为单个 WebSocket）。
 */
export class LanMultiplayer {
  private readonly opts: LanMultiplayerOptions;
  private panel: vscode.WebviewPanel | null = null;
  private wss: WebSocketServer | null = null;
  private clientWs: WebSocket | null = null;
  private readonly peers = new Map<WebSocket, PeerEntry>();
  private peerSeq = 0;
  private mode: 'host' | 'client' | null = null;
  private readonly cmdDisposables: vscode.Disposable[] = [];

  constructor(opts: LanMultiplayerOptions) {
    this.opts = opts;
  }

  /** 当前角色；未开始联机时为 null。 */
  get role(): 'host' | 'client' | null {
    return this.mode;
  }

  /** 当前已连 peerId 列表（host 侧）。 */
  get peerIds(): string[] {
    return [...this.peers.values()].map((p) => p.id);
  }

  /** 注册 {prefix}.multiCreate / {prefix}.multiJoin 命令，返回可释放的 Disposable。 */
  registerCommands(): vscode.Disposable {
    const create = vscode.commands.registerCommand(
      `${this.opts.commandPrefix}.multiCreate`,
      () => this.startHost()
    );
    const join = vscode.commands.registerCommand(
      `${this.opts.commandPrefix}.multiJoin`,
      () => this.startClient()
    );
    const disp = vscode.Disposable.from(create, join);
    this.cmdDisposables.push(disp);
    return disp;
  }

  /** 关闭所有 socket 与面板，释放命令。宿主卸载扩展时调用。 */
  dispose(): void {
    this.closeAllSockets();
    this.disposePanel();
    for (const d of this.cmdDisposables) {
      try {
        d.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    this.cmdDisposables.length = 0;
  }

  /** host 侧：向所有 peer 广播。 */
  broadcast(msg: MultiMessage): void {
    for (const { ws } of this.peers.values()) {
      this.sendRaw(ws, msg);
    }
  }

  /** host 侧：向指定 peerId 单播。 */
  sendTo(peerId: string, msg: MultiMessage): void {
    for (const entry of this.peers.values()) {
      if (entry.id === peerId) {
        this.sendRaw(entry.ws, msg);
        break;
      }
    }
  }

  /** 向 webview 推送消息（host / client 均可）。 */
  sendToWebview(msg: MultiMessage): void {
    if (this.panel) {
      this.panel.webview.postMessage(msg);
    }
  }

  /** 项目侧向当前 webview 推送任意消息（host / client 均可）；面板未开时为 no-op。 */
  postToWebview(msg: MultiMessage): void {
    this.sendToWebview(msg);
  }

  private resolvePort(): number {
    return typeof this.opts.port === 'function' ? this.opts.port() : this.opts.port;
  }

  private i18n(): MultiI18n {
    return this.opts.i18n ?? {};
  }

  private closeAllSockets(): void {
    for (const { ws } of this.peers.values()) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.peers.clear();
    if (this.wss) {
      try {
        this.wss.close();
      } catch (_) {
        /* ignore */
      }
      this.wss = null;
    }
    if (this.clientWs) {
      try {
        this.clientWs.close();
      } catch (_) {
        /* ignore */
      }
      this.clientWs = null;
    }
    this.mode = null;
  }

  private disposePanel(): void {
    if (this.panel) {
      try {
        this.panel.dispose();
      } catch (_) {
        /* ignore */
      }
      this.panel = null;
    }
  }

  private makeHtml(role: 'host' | 'client', host: string, port: number): string {
    const htmlPath = this.opts.webviewHtmlPath(this.opts.context);
    const html = fs.readFileSync(htmlPath.fsPath, 'utf-8');
    const bootstrap = JSON.stringify(
      this.opts.buildBootstrap({ role, host, port, localIp: getLocalIPv4() })
    );
    const token = this.opts.bootstrapHtmlToken ?? DEFAULT_BOOTSTRAP_TOKEN;
    // 全局替换：防止 token 在 HTML 注释与代码里多处出现时只替换其中一处。
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return html.replace(new RegExp(escaped, 'g'), bootstrap);
  }

  private createPanel(viewType: string): vscode.WebviewPanel {
    const htmlUri = this.opts.webviewHtmlPath(this.opts.context);
    const resourceRoots = this.opts.localResourceRoots
      ? this.opts.localResourceRoots(this.opts.context)
      : [vscode.Uri.joinPath(htmlUri, '..')];
    const panel = vscode.window.createWebviewPanel(
      viewType,
      '联机对战',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots,
      }
    );
    panel.webview.onDidReceiveMessage((msg: MultiMessage) => this.onWebviewMessage(msg));
    panel.onDidDispose(() => {
      this.closeAllSockets();
      this.panel = null;
    });
    return panel;
  }

  /**
   * 发出 peer 进出事件：发语义化 peerConnected/peerDisconnected（载荷仅 from 与 peers，
   * 不再带 id、不再发 peerChange），最后调用 onPeerChange 钩子。
   */
  private emitPeerEvent(kind: 'join' | 'leave', peerId: string): void {
    const peers = this.peerIds;
    const type = kind === 'join' ? EVT.peerConnected : EVT.peerDisconnected;
    this.sendToWebview({ type, from: peerId, peers });
    if (this.opts.onPeerChange) {
      this.opts.onPeerChange({ kind, peerId, peers });
    }
  }

  /** host 模式：启动 WebSocketServer 并打开房主面板。 */
  private async startHost(): Promise<void> {
    this.closeAllSockets();
    this.disposePanel();
    const ip = getLocalIPv4();
    const port = this.resolvePort();
    const panel = this.createPanel(this.opts.viewTypeHost);
    this.panel = panel;
    this.mode = 'host';
    panel.webview.html = this.makeHtml('host', ip, port);

    const wss = new WebSocketServer({ port });
    this.wss = wss;
    wss.on('listening', () => {
      this.sendToWebview({ type: EVT.hostReady, host: ip, port });
      const t = this.i18n().roomCreated;
      vscode.window.showInformationMessage(
        t ? t(ip, port) : `房间已创建！请让对手加入房间：${ip}:${port}`
      );
    });
    wss.on('error', (err: Error) => {
      const e = err as NodeJS.ErrnoException;
      const portInUse = this.i18n().portInUse;
      const message =
        e && e.code === 'EADDRINUSE' && portInUse
          ? portInUse(port)
          : `创建房间失败: ${e.message}`;
      this.sendToWebview({ type: EVT.hostError, message });
      vscode.window.showErrorMessage(message);
    });
    wss.on('connection', (ws: WebSocket) => {
      const max = this.opts.maxPeers ?? DEFAULT_MAX_PEERS;
      if (this.peers.size >= max) {
        try {
          ws.close(1013, 'Room is full');
        } catch (_) {
          /* ignore */
        }
        return;
      }
      const id = `p${++this.peerSeq}`;
      this.peers.set(ws, { ws, id });
      ws.on('message', (buf: Buffer | ArrayBuffer | Buffer[]) =>
        this.onPeerMessage(id, String(buf))
      );
      ws.on('close', () => this.onPeerLeave(ws));
      ws.on('error', () => this.onPeerLeave(ws));
      this.emitPeerEvent('join', id);
    });
  }

  private onPeerLeave(ws: WebSocket): void {
    const entry = this.peers.get(ws);
    if (!entry) {
      return;
    }
    this.peers.delete(ws);
    this.emitPeerEvent('leave', entry.id);
  }

  /** peer→webview：自动补 from 字段后转发。 */
  private onPeerMessage(fromId: string, data: string): void {
    if (!this.panel) {
      return;
    }
    let obj: MultiMessage;
    try {
      obj = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (obj && typeof obj === 'object') {
      obj.from = fromId;
    }
    this.panel.webview.postMessage(obj);
  }

  /** client 模式：输入地址并连接 host。 */
  private async startClient(): Promise<void> {
    this.closeAllSockets();
    this.disposePanel();
    const t = this.i18n();
    const input = await vscode.window.showInputBox({
      prompt: t.joinPrompt?.() ?? '请输入房主的 IP:端口（例如 192.168.1.10:18765）',
      placeHolder: '192.168.1.10:18765',
      ignoreFocusOut: true,
    });
    if (!input) {
      return;
    }
    const trimmed = input.trim();
    const m = trimmed.match(/^([^:]+)(?::(\d+))?$/);
    if (!m) {
      vscode.window.showErrorMessage(
        t.invalidAddress ? t.invalidAddress(trimmed) : '地址格式错误，请使用 IP:端口 格式'
      );
      return;
    }
    const host = m[1];
    const port = m[2] ? parseInt(m[2], 10) : this.resolvePort();

    const panel = this.createPanel(this.opts.viewTypeClient);
    this.panel = panel;
    this.mode = 'client';
    panel.webview.html = this.makeHtml('client', host, port);

    const url = `ws://${host}:${port}`;
    const ws = new WebSocket(url);
    this.clientWs = ws;
    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let openFired = false;
    const timer = setTimeout(() => {
      if (!openFired) {
        try {
          ws.terminate();
        } catch (_) {
          /* ignore */
        }
        const message = t.connectTimeout
          ? t.connectTimeout(timeoutMs)
          : `连接超时：无法在 ${timeoutMs}ms 内连接到 ${url}，请检查 IP/端口/防火墙/是否同一局域网。`;
        this.sendToWebview({ type: EVT.clientTimeout, message });
        vscode.window.showErrorMessage(message);
      }
    }, timeoutMs);

    ws.on('open', () => {
      openFired = true;
      clearTimeout(timer);
      this.sendToWebview({ type: EVT.clientConnected });
    });
    ws.on('message', (buf: Buffer | ArrayBuffer | Buffer[]) => {
      let obj: MultiMessage;
      try {
        obj = JSON.parse(String(buf));
      } catch (_) {
        return;
      }
      this.panel?.webview.postMessage(obj);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!openFired) {
        const message = t.connectFailed
          ? t.connectFailed(`${host}:${port}`)
          : `连接被拒绝：${host}:${port}（房主是否已开启房间？端口是否正确？）`;
        this.sendToWebview({ type: EVT.clientRefused, message });
      } else {
        this.sendToWebview({ type: EVT.clientDisconnected });
      }
      this.clientWs = null;
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      const message = t.connectFailed
        ? t.connectFailed(err.message)
        : `连接房间失败: ${err.message}`;
      this.sendToWebview({ type: EVT.clientError, message });
      vscode.window.showErrorMessage(message);
    });
  }

  /** webview→网络：默认转发规则 + 可选拦截钩子。 */
  private onWebviewMessage(msg: MultiMessage): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const api: WebviewMessageApi = {
      role: this.mode ?? 'client',
      peers: () => this.peerIds,
      broadcast: (m) => this.broadcast(m),
      sendTo: (id, m) => this.sendTo(id, m),
    };
    if (this.opts.onWebviewMessage && this.opts.onWebviewMessage(msg, api) === true) {
      return;
    }
    if (this.mode === 'host') {
      if (typeof msg.to === 'string' && msg.to) {
        this.sendTo(msg.to, msg);
      } else {
        this.broadcast(msg);
      }
    } else if (this.mode === 'client' && this.clientWs) {
      this.sendRaw(this.clientWs, msg);
    }
  }

  private sendRaw(ws: WebSocket, msg: MultiMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch (_) {
      /* 单点故障不影响其他 peer */
    }
  }
}
