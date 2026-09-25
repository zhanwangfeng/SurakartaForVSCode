import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanMultiplayer } from './common';

type Mode = 'pvp' | 'ai';

interface GameNode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  mode?: Mode;
  depth?: number;
  command?: string;
  children?: GameNode[];
}

const NICK_KEY = 'surakarta.nickname';
const SOUND_KEY = 'surakarta.sound';
const DEFAULT_PORT = 18766;

let panel: vscode.WebviewPanel | undefined;
let multi: LanMultiplayer | undefined;

function getNickname(context: vscode.ExtensionContext): string {
  return context.globalState.get<string>(NICK_KEY) || '玩家';
}

function isSoundOn(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(SOUND_KEY) !== false;
}

function getPort(): number {
  return vscode.workspace.getConfiguration('surakarta').get<number>('multiPort') ?? DEFAULT_PORT;
}

// 左侧 TreeView 菜单：单机模式（双人同屏 / 人机对战 三档）+ 联机对战（创建房间、加入房间、设定昵称、音效开关）
class SurakartaTreeDataProvider implements vscode.TreeDataProvider<GameNode> {
  private readonly emitter = new vscode.EventEmitter<GameNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: GameNode): vscode.TreeItem {
    const collapsible = element.children && element.children.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    if (element.description) {
      item.description = element.description;
    }
    item.tooltip = element.description ? `${element.label} · ${element.description}` : element.label;
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    if (element.command) {
      item.command = { command: element.command, title: element.label };
    } else if (element.mode) {
      item.command = {
        command: 'surakarta.open',
        title: '打开',
        arguments: [element.mode, element.depth ?? 3]
      };
    }
    return item;
  }

  getChildren(element?: GameNode): GameNode[] {
    if (element) {
      return element.children ?? [];
    }
    const nick = getNickname(this.context);
    const sound = isSoundOn(this.context);
    return [
      {
        id: 'local', label: '单机模式', icon: 'device-desktop', children: [
          { id: 'pvp',       label: '双人同屏',     description: '两名玩家轮流', mode: 'pvp', depth: 3 },
          { id: 'ai-easy',   label: '人机对战 低', description: 'AI 搜索 2 层', mode: 'ai',  depth: 2 },
          { id: 'ai-normal', label: '人机对战 中', description: 'AI 搜索 3 层', mode: 'ai',  depth: 3 },
          { id: 'ai-hard',   label: '人机对战 高', description: 'AI 搜索 4 层', mode: 'ai',  depth: 4 }
        ]
      },
      {
        id: 'online', label: '联机对战', icon: 'broadcast', description: '端口 ' + getPort(), children: [
          { id: 'multi-create',  label: '创建房间', description: '作为房主，等待对手加入', icon: 'radio-tower', command: 'surakarta.multiCreate' },
          { id: 'multi-join',    label: '加入房间', description: '输入房主 IP:端口',       icon: 'sign-in',     command: 'surakarta.multiJoin' },
          { id: 'set-nickname',  label: '设定昵称', description: nick,                      icon: 'account',     command: 'surakarta.setNickname' },
          { id: 'toggle-sound',  label: '音效开关', description: sound ? '已开启' : '已关闭', icon: sound ? 'unmute' : 'mute', command: 'surakarta.toggleSound' }
        ]
      }
    ];
  }
}

// 读取 src/webview/game.html（照抄自 demo/index.html），注入初始模式/难度并设置消息钩子
function getWebviewContent(context: vscode.ExtensionContext, mode: Mode, depth: number): string {
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'game.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

  const script = `<script>
window.__SK__ = ${JSON.stringify({ mode, depth, sound: isSoundOn(context) })};
(function () {
  var rawPlaySound = playSound;
  function applySound(on) { playSound = on ? rawPlaySound : function () {}; }
  function apply(c) {
    var ms = document.getElementById('mode'), ds = document.getElementById('diff');
    if (ms && c.mode) ms.value = c.mode;
    if (ds && c.depth != null) ds.value = String(c.depth);
    var r = document.getElementById('restart'); if (r) r.click();
  }
  apply(window.__SK__ || { mode: 'pvp', depth: 3 });
  applySound(window.__SK__.sound !== false);
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'start') apply({ mode: e.data.mode, depth: e.data.depth });
    else if (e.data.type === 'restart') { var r = document.getElementById('restart'); if (r) r.click(); }
    else if (e.data.type === 'sound') applySound(e.data.on !== false);
  });
})();
</script>`;
  html = html.replace('</body>', script + '\n</body>');

  return html;
}

function openGame(context: vscode.ExtensionContext, mode: Mode, depth: number) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    panel.webview.postMessage({ type: 'start', mode, depth });
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'surakarta',
    '苏拉卡尔塔 Surakarta',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')]
    }
  );
  panel.webview.html = getWebviewContent(context, mode, depth);
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function activate(context: vscode.ExtensionContext) {
  // 联机：复用 src/common 的局域网联机模块，UI 使用 src/webview/multi.html（照抄 game.html）
  multi = new LanMultiplayer({
    context,
    commandPrefix: 'surakarta',
    viewTypeHost: 'surakarta.multiHost',
    viewTypeClient: 'surakarta.multiClient',
    port: () => getPort(),
    maxPeers: 1,                                  // 1v1 对战
    webviewHtmlPath: (ctx) => vscode.Uri.joinPath(ctx.extensionUri, 'src', 'webview', 'multi.html'),
    localResourceRoots: (ctx) => [vscode.Uri.joinPath(ctx.extensionUri, 'src', 'webview')],
    buildBootstrap: (p) => ({ ...p, nickname: getNickname(context), sound: isSoundOn(context) }),
    i18n: {
      roomCreated: (ip, port) => `房间已创建！请让对手加入房间：${ip}:${port}`,
      portInUse: (port) => `端口 ${port} 已被占用，请修改设置 surakarta.multiPort 后重试`,
      joinPrompt: () => `请输入房主的 IP:端口（例如 192.168.1.10:${getPort()}）`,
      invalidAddress: (raw) => `地址格式错误：${raw}，请使用 IP:端口 格式`,
      connectFailed: (err) => `连接房间失败：${err}`,
      connectTimeout: (ms) => `连接超时：${ms}ms 内未能连接，请检查 IP/端口/防火墙/是否同一局域网`
    }
  });
  context.subscriptions.push(multi, multi.registerCommands());

  const provider = new SurakartaTreeDataProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('surakarta.modes', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('surakarta.open', (mode?: Mode, depth?: number) =>
      openGame(context, mode ?? 'pvp', depth ?? 3))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('surakarta.restart', () => {
      if (panel) {
        panel.webview.postMessage({ type: 'restart' });
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('surakarta.openWeb', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://codejson.cn/games/surakarta/')))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('surakarta.setNickname', async () => {
      const input = await vscode.window.showInputBox({
        title: '苏拉卡尔塔：设定昵称',
        prompt: '联机对战时显示给对手的昵称',
        value: getNickname(context),
        ignoreFocusOut: true
      });
      if (input === undefined) {
        return;
      }
      const nick = input.trim() || '玩家';
      await context.globalState.update(NICK_KEY, nick);
      multi?.postToWebview({ type: 'setNick', name: nick });
      provider.refresh();
      vscode.window.showInformationMessage(`昵称已设置为：${nick}`);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('surakarta.toggleSound', async () => {
      const on = !isSoundOn(context);
      await context.globalState.update(SOUND_KEY, on);
      multi?.postToWebview({ type: 'sound', on });
      if (panel) {
        panel.webview.postMessage({ type: 'sound', on });
      }
      provider.refresh();
      vscode.window.showInformationMessage(on ? '音效已开启' : '音效已关闭');
    })
  );
}

export function deactivate() {}
