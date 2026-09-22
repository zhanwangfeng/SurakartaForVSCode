import * as vscode from 'vscode';
import * as fs from 'fs';

type Mode = 'pvp' | 'ai';

interface GameNode {
  id: string;
  label: string;
  description?: string;
  mode?: Mode;
  depth?: number;
  children?: GameNode[];
}

// 左侧 TreeView 菜单：双人同屏 / 人机对战（简、中、难）
const TREE: GameNode[] = [
  { id: 'pvp',       label: '双人同屏',     description: '两名玩家轮流',      mode: 'pvp', depth: 3 },
  { id: 'ai-easy',   label: '人机对战 低', description: 'AI 搜索 2 层', mode: 'ai',  depth: 2 },
  { id: 'ai-normal', label: '人机对战 中', description: 'AI 搜索 3 层', mode: 'ai',  depth: 3 },
  { id: 'ai-hard',   label: '人机对战 高', description: 'AI 搜索 4 层', mode: 'ai',  depth: 4 }
];

class SurakartaTreeDataProvider implements vscode.TreeDataProvider<GameNode> {
  getTreeItem(element: GameNode): vscode.TreeItem {
    const collapsible = element.children && element.children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    if (element.description) {
      item.description = element.description;
    }
    item.tooltip = element.label;
    if (element.mode) {
      item.command = {
        command: 'surakarta.open',
        title: '打开',
        arguments: [element.mode, element.depth ?? 3]
      };
    }
    return item;
  }

  getChildren(element?: GameNode): GameNode[] {
    return element ? (element.children ?? []) : TREE;
  }
}

let panel: vscode.WebviewPanel | undefined;

// 读取 src/webview/game.html（照抄自 demo/index.html），注入初始模式/难度并设置消息钩子
function getWebviewContent(context: vscode.ExtensionContext, mode: Mode, depth: number): string {
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'game.html');
  let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

  const script = `<script>
window.__SK__ = ${JSON.stringify({ mode, depth })};
(function () {
  function apply(c) {
    var ms = document.getElementById('mode'), ds = document.getElementById('diff');
    if (ms && c.mode) ms.value = c.mode;
    if (ds && c.depth != null) ds.value = String(c.depth);
    var r = document.getElementById('restart'); if (r) r.click();
  }
  apply(window.__SK__ || { mode: 'pvp', depth: 3 });
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'start') apply({ mode: e.data.mode, depth: e.data.depth });
    else if (e.data.type === 'restart') { var r = document.getElementById('restart'); if (r) r.click(); }
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
    vscode.window.registerTreeDataProvider('surakarta.modes', new SurakartaTreeDataProvider())
  );
}

export function deactivate() {}
