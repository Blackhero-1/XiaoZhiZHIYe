const COLORS = ["#dd704f", "#557d69", "#6270ba", "#bb8c37", "#936c99"];
const NODE_WIDTH = 228;
const NODE_HEIGHT = 82;
const ROOT_WIDTH = 244;
const ROOT_HEIGHT = 86;
const PAGE_SIZE = 120;

const state = {
  root: null,
  selected: null,
  selectedPaths: new Set(),
  navHistory: [],
  operations: [],
  operationLog: readStorage("mindfile.operationLog", []),
  clipboard: { mode: null, paths: [] },
  zoom: 0.9,
  pan: { x: 0, y: 0 },
  panning: null,
  selecting: null,
  draggingNode: null,
  search: "",
  searchResults: new Set(),
  searchPaths: new Set(),
  searchInfo: new Map(),
  watchedPaths: new Set(),
  layout: null,
  favorites: readStorage("mindfile.favorites", []),
  workspaces: readStorage("mindfile.workspaces", []),
  allPins: readStorage("mindfile.pins", {}),
  suppressWatchUntil: 0,
  refreshTimer: null,
};

const elements = Object.fromEntries([
  "quickAccess", "driveList", "favoritesList", "workspaceList", "operationHistoryList", "addFavoriteButton", "saveWorkspaceButton", "undoButton",
  "backButton", "upButton", "refreshButton", "pathInput", "goButton", "searchInput", "searchButton", "searchType", "searchSize",
  "searchModified", "clearSearchButton", "searchStatus", "chooseFolderButton", "welcomeChooseButton", "viewport", "stage", "edges", "nodesLayer",
  "selectionBox", "welcome", "zoomOut", "zoomIn", "zoomLabel", "fitButton", "locateButton", "collapseOthersButton", "collapseAllButton",
  "centerButton", "minimap", "loadNotice", "inspector", "inspectorContent", "preview", "nameRow", "nameInput", "renameButton", "selectedCount",
  "metaType", "metaSize", "metaModified", "metaExtension", "fullPath", "openButton", "revealButton", "newFolderButton", "pasteButton",
  "copyButton", "moveButton", "trashButton", "propertiesButton", "copyPathButton", "favoriteButton", "toast", "busy",
].map((id) => [id, document.getElementById(id)]));

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Local settings are best-effort. */ }
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 3000);
}

function setBusy(value, label = "正在读取磁盘…") {
  elements.busy.querySelector("p").textContent = label;
  elements.busy.classList.toggle("hidden", !value);
}

function normalizePath(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLocaleLowerCase();
}

function pathIsInside(itemPath, parentPath) {
  const item = normalizePath(itemPath);
  const parent = normalizePath(parentPath);
  return item === parent || item.startsWith(`${parent}\\`);
}

function parentPathOf(itemPath) {
  const cleaned = String(itemPath || "").replace(/[\\/]+$/, "");
  const parent = cleaned.replace(/[\\/][^\\/]+$/, "");
  return parent && parent !== cleaned ? parent : itemPath;
}

function baseNameOf(itemPath) {
  return String(itemPath || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || itemPath;
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function extensionLabel(node) {
  if (node.type === "folder") return "DIR";
  return (node.extension || "FILE").replace(".", "").slice(0, 4).toUpperCase();
}

function currentPins() {
  if (!state.root) return {};
  const key = normalizePath(state.root.path);
  if (!state.allPins[key]) state.allPins[key] = {};
  return state.allPins[key];
}

function savePins() {
  if (!state.root) return;
  const pins = currentPins();
  walkTree(state.root, (node) => {
    const key = normalizePath(node.path);
    if (node.pinned) pins[key] = { x: node.pinnedX ?? node.x, y: node.pinnedY ?? node.y };
    else delete pins[key];
  });
  writeStorage("mindfile.pins", state.allPins);
}

function makeNode(info, parent = null, depth = 0, branch = 0) {
  const pin = state.root ? currentPins()[normalizePath(info.path)] : null;
  return {
    ...info, parent, depth, branch, children: [], loaded: false, expanded: false, x: 0, y: 0, side: 1,
    pageOffset: 0, total: 0, hasMore: false, pinned: Boolean(pin), pinnedX: pin?.x, pinnedY: pin?.y,
  };
}

async function watchFolder(node) {
  const key = normalizePath(node.path);
  if (state.watchedPaths.has(key)) return;
  state.watchedPaths.add(key);
  try { await window.mindfile.watch(node.path); } catch { state.watchedPaths.delete(key); }
}

async function loadChildren(node, expand = true, append = false) {
  if (node.type !== "folder") return;
  const offset = append ? node.pageOffset : 0;
  const result = await window.mindfile.listDirectory(node.path, { offset, limit: PAGE_SIZE });
  const fresh = result.items.map((item, index) => makeNode(item, node, node.depth + 1, node.depth === 0 ? offset + index : node.branch));
  if (append) {
    const existing = new Set(node.children.map((child) => normalizePath(child.path)));
    node.children.push(...fresh.filter((child) => !existing.has(normalizePath(child.path))));
  } else {
    node.children = fresh;
  }
  node.loaded = true;
  node.expanded = expand;
  node.pageOffset = result.nextOffset;
  node.total = result.total;
  node.hasMore = result.hasMore;
  void watchFolder(node);
}

async function loadMore(node) {
  if (!node?.hasMore) return;
  setBusy(true, `正在继续读取“${node.name}”…`);
  try {
    await loadChildren(node, true, true);
    reindexTree();
    renderGraph();
    showToast(`已显示 ${node.children.length} / ${node.total} 项`);
  } catch (error) { showToast(error.message || "继续加载失败", true); }
  finally { setBusy(false); }
}

function walkTree(node, visitor) {
  if (!node) return;
  visitor(node);
  node.children.forEach((child) => walkTree(child, visitor));
}

function findNode(itemPath) {
  const target = normalizePath(itemPath);
  let match = null;
  walkTree(state.root, (node) => { if (!match && normalizePath(node.path) === target) match = node; });
  return match;
}

function selectedNodes(includeRoot = false) {
  const result = [];
  for (const itemPath of state.selectedPaths) {
    const node = findNode(itemPath);
    if (node && (includeRoot || node.depth > 0)) result.push(node);
  }
  if (!result.length && state.selected && (includeRoot || state.selected.depth > 0)) result.push(state.selected);
  return result;
}

function selectOnly(node) {
  state.selected = node;
  state.selectedPaths = new Set(node ? [node.path] : []);
}

function toggleSelection(node) {
  const currentKey = normalizePath(node.path);
  let matchingPath = null;
  for (const itemPath of state.selectedPaths) if (normalizePath(itemPath) === currentKey) matchingPath = itemPath;
  if (matchingPath) {
    state.selectedPaths.delete(matchingPath);
    if (normalizePath(state.selected?.path) === currentKey) state.selected = selectedNodes(true)[0] || null;
  } else {
    state.selectedPaths.add(node.path);
    state.selected = node;
  }
  if (!state.selected) selectOnly(state.root);
}

function sortChildren(node) {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : b.type === "folder" ? 1 : 0;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

function reindexTree() {
  if (!state.root) return;
  const assign = (node, depth, branch) => {
    node.depth = depth;
    node.branch = branch;
    node.children.forEach((child, index) => {
      child.parent = node;
      assign(child, depth + 1, depth === 0 ? index : branch);
    });
  };
  state.root.parent = null;
  assign(state.root, 0, 0);
}

function collectExpandedPaths() {
  const result = [];
  walkTree(state.root, (node) => { if (node.type === "folder" && node.expanded) result.push(node.path); });
  return result;
}

async function restoreExpandedNodes(node, expandedSet) {
  for (const child of node.children) {
    if (child.type === "folder" && expandedSet.has(normalizePath(child.path))) {
      try {
        await loadChildren(child, true);
        await restoreExpandedNodes(child, expandedSet);
      } catch { child.expanded = false; }
    }
  }
}

async function openRoot(rootPath, addHistory = true, fit = true) {
  if (!rootPath) return;
  setBusy(true);
  try {
    if (state.root && addHistory) state.navHistory.push(state.root.path);
    await window.mindfile.unwatchAll();
    state.watchedPaths.clear();
    const info = await window.mindfile.getInfo(rootPath);
    if (info.type !== "folder") throw new Error("请选择磁盘或文件夹");
    state.root = makeNode(info);
    state.root.branch = 0;
    await loadChildren(state.root, true);
    selectOnly(state.root);
    state.searchResults.clear();
    state.searchPaths.clear();
    elements.searchStatus.textContent = "";
    elements.pathInput.value = state.root.path;
    elements.welcome.classList.add("hidden");
    elements.backButton.disabled = state.navHistory.length === 0;
    renderGraph();
    await showInspector(state.root);
    if (fit) requestAnimationFrame(fitGraph);
    markActiveNavigation(state.root.path);
  } catch (error) { showToast(error.message || "无法打开这个位置", true); }
  finally { setBusy(false); }
}

async function refreshRoot(message = "已同步文件变化", quiet = false) {
  if (!state.root) return;
  const currentPath = state.root.path;
  const selectedPath = state.selected?.path;
  const selectedPathList = [...state.selectedPaths];
  const expanded = new Set(collectExpandedPaths().map(normalizePath));
  if (!quiet) setBusy(true, "正在同步文件变化…");
  try {
    const info = await window.mindfile.getInfo(currentPath);
    state.root = makeNode(info);
    await loadChildren(state.root, true);
    await restoreExpandedNodes(state.root, expanded);
    reindexTree();
    state.selected = findNode(selectedPath) || state.root;
    state.selectedPaths = new Set(selectedPathList.filter((itemPath) => findNode(itemPath)));
    if (!state.selectedPaths.size) state.selectedPaths.add(state.selected.path);
    renderGraph();
    await showInspector(state.selected);
    if (!quiet) showToast(message);
  } catch (error) { showToast(error.message || "刷新失败", true); }
  finally { if (!quiet) setBusy(false); }
}

function visibleChildren(node) { return node.expanded ? node.children : []; }
function subtreeRows(node) {
  const children = visibleChildren(node);
  return children.length ? Math.max(1, children.reduce((sum, child) => sum + subtreeRows(child), 0)) : 1;
}

function layoutGraph() {
  const root = state.root;
  if (!root) return { width: 2200, height: 1200, nodes: [] };
  const rowHeight = 108;
  const columnWidth = 324;
  const rootX = 1040;
  const placed = [root];
  const firstChildren = visibleChildren(root);
  const left = firstChildren.filter((_child, index) => index % 2 === 1);
  const right = firstChildren.filter((_child, index) => index % 2 === 0);
  const leftRows = Math.max(1, left.reduce((sum, child) => sum + subtreeRows(child), 0));
  const rightRows = Math.max(1, right.reduce((sum, child) => sum + subtreeRows(child), 0));
  const totalRows = Math.max(leftRows, rightRows, 5);
  let graphHeight = Math.max(760, totalRows * rowHeight + 160);
  root.x = rootX;
  root.y = graphHeight / 2 - ROOT_HEIGHT / 2;
  root.side = 0;

  function placeBranch(node, side, depth, startRow) {
    const rows = subtreeRows(node);
    node.side = side;
    node.x = rootX + side * columnWidth * depth + (side < 0 ? -10 : 10);
    node.y = 80 + (startRow + rows / 2) * rowHeight - NODE_HEIGHT / 2;
    const pin = currentPins()[normalizePath(node.path)];
    if (pin) {
      node.pinned = true;
      node.pinnedX = pin.x;
      node.pinnedY = pin.y;
      node.x = Math.max(12, pin.x);
      node.y = Math.max(12, pin.y);
    }
    placed.push(node);
    let cursor = startRow;
    for (const child of visibleChildren(node)) {
      placeBranch(child, side, depth + 1, cursor);
      cursor += subtreeRows(child);
    }
  }

  let cursor = (totalRows - leftRows) / 2;
  for (const child of left) { placeBranch(child, -1, 1, cursor); cursor += subtreeRows(child); }
  cursor = (totalRows - rightRows) / 2;
  for (const child of right) { placeBranch(child, 1, 1, cursor); cursor += subtreeRows(child); }
  const maxDepth = Math.max(1, ...placed.map((node) => node.depth));
  const maxX = Math.max(...placed.map((node) => node.x + (node.depth === 0 ? ROOT_WIDTH : NODE_WIDTH))) + 100;
  const maxY = Math.max(...placed.map((node) => node.y + (node.depth === 0 ? ROOT_HEIGHT : NODE_HEIGHT))) + 100;
  graphHeight = Math.max(graphHeight, maxY);
  return { width: Math.max(2200, rootX * 2 + maxDepth * 250, maxX), height: graphHeight, nodes: placed };
}

function createEdge(node) {
  if (!node.parent) return null;
  const parent = node.parent;
  const right = node.side > 0;
  const parentWidth = parent.depth === 0 ? ROOT_WIDTH : NODE_WIDTH;
  const x1 = parent.x + (right ? parentWidth : 0);
  const y1 = parent.y + (parent.depth === 0 ? ROOT_HEIGHT / 2 : NODE_HEIGHT / 2);
  const x2 = node.x + (right ? 0 : NODE_WIDTH);
  const y2 = node.y + NODE_HEIGHT / 2;
  const bend = Math.max(55, Math.abs(x2 - x1) * 0.46);
  const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pathElement.setAttribute("d", `M ${x1} ${y1} C ${x1 + (right ? bend : -bend)} ${y1}, ${x2 + (right ? -bend : bend)} ${y2}, ${x2} ${y2}`);
  pathElement.setAttribute("stroke", COLORS[node.branch % COLORS.length]);
  if (state.searchPaths.has(normalizePath(node.path))) pathElement.classList.add("search-path-edge");
  return pathElement;
}

function createGraphNode(node) {
  const article = document.createElement("article");
  const isPrimary = normalizePath(state.selected?.path) === normalizePath(node.path);
  const isSelected = [...state.selectedPaths].some((itemPath) => normalizePath(itemPath) === normalizePath(node.path));
  article.className = `graph-node ${node.type}-node ${node.depth === 0 ? "root" : ""} ${isPrimary ? "selected" : ""} ${isSelected && !isPrimary ? "multi-selected" : ""} ${node.pinned ? "pinned" : ""}`;
  article.style.left = `${node.x}px`;
  article.style.top = `${node.y}px`;
  article.style.setProperty("--branch", COLORS[node.branch % COLORS.length]);
  article.dataset.path = node.path;
  article.title = `${node.name}\n${node.path}${node.pinned ? "\n位置已固定" : ""}`;
  article.draggable = node.depth > 0;

  const searchKey = normalizePath(node.path);
  const localMatch = state.search && `${node.name} ${node.path}`.toLocaleLowerCase().includes(state.search);
  if (state.searchResults.has(searchKey) || localMatch) article.classList.add("search-match");
  else if (state.searchPaths.has(searchKey)) article.classList.add("search-path-node");
  else if (state.search || state.searchResults.size) article.classList.add("search-dim");
  if (state.clipboard.mode === "cut" && state.clipboard.paths.some((itemPath) => normalizePath(itemPath) === searchKey)) article.classList.add("cut-node");

  const icon = document.createElement("div");
  icon.className = `file-icon ${node.type}`;
  if (node.type !== "folder") {
    const ext = document.createElement("span");
    ext.textContent = extensionLabel(node);
    icon.appendChild(ext);
  }
  // The graph root represents the selected disk/location and keeps its
  // Windows icon. Ordinary directories always use a clear folder glyph.
  if (node.type !== "folder" || node.depth === 0) {
    void window.mindfile.getIcon(node.path).then((dataUrl) => {
      if (!dataUrl || !article.isConnected) return;
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = "";
      icon.replaceChildren(image);
      icon.classList.add("native-file-icon");
    }).catch(() => {});
  }

  const copy = document.createElement("div");
  copy.className = "node-copy";
  const name = document.createElement("strong");
  name.textContent = node.name;
  const meta = document.createElement("span");
  meta.textContent = node.type === "folder"
    ? node.loaded ? `${node.children.length}${node.total ? ` / ${node.total}` : ""} 项${node.expanded ? " · 已展开" : ""}` : "双击展开"
    : formatSize(node.size);
  copy.append(name, meta);
  article.append(icon, copy);

  if (node.pinned) {
    const badge = document.createElement("b");
    badge.className = "pin-badge";
    badge.textContent = "•";
    badge.title = "位置已固定";
    article.appendChild(badge);
  }

  if (node.type === "folder") {
    const expand = document.createElement("button");
    expand.className = "expand-button";
    expand.title = node.expanded ? "收起" : "展开";
    expand.textContent = node.expanded ? "−" : "+";
    expand.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        setBusy(true, "正在展开文件夹…");
        if (node.loaded) node.expanded = !node.expanded;
        else await loadChildren(node, true);
        renderGraph();
      } catch (error) { showToast(error.message || "无法读取文件夹", true); }
      finally { setBusy(false); }
    });
    article.appendChild(expand);
    if (node.expanded && node.hasMore) {
      const more = document.createElement("button");
      more.className = "load-more-button";
      more.textContent = `再加载 ${Math.min(PAGE_SIZE, node.total - node.children.length)} 项`;
      more.title = `当前 ${node.children.length} / ${node.total} 项`;
      more.addEventListener("click", (event) => { event.stopPropagation(); void loadMore(node); });
      article.appendChild(more);
    }
  }

  if (node.depth > 0) {
    const anchor = document.createElement("i");
    anchor.className = `node-anchor ${node.side > 0 ? "left" : "right"}`;
    article.appendChild(anchor);
  }

  article.addEventListener("click", async (event) => {
    if (event.ctrlKey) toggleSelection(node); else selectOnly(node);
    renderGraph();
    await showInspector(state.selected);
  });
  article.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const alreadySelected = [...state.selectedPaths].some((itemPath) => normalizePath(itemPath) === normalizePath(node.path));
    if (!alreadySelected) selectOnly(node); else state.selected = node;
    renderGraph();
    void showInspector(node);
    window.mindfile.showContextMenu({
      type: node.type, isRoot: node.depth === 0, expanded: node.expanded, pinned: node.pinned,
      selectionCount: selectedNodes().length, canPaste: state.clipboard.paths.length > 0,
    });
  });
  article.addEventListener("dblclick", async () => {
    if (node.type === "folder") await toggleNode(node);
    else try { await window.mindfile.open(node.path); } catch (error) { showToast(error.message, true); }
  });
  article.addEventListener("dragstart", (event) => {
    if (event.altKey) { event.preventDefault(); return; }
    if (![...state.selectedPaths].some((itemPath) => normalizePath(itemPath) === normalizePath(node.path))) selectOnly(node);
    const paths = selectedNodes().map((item) => item.path);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-mindfile-paths", JSON.stringify(paths));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
  });
  if (node.type === "folder") {
    article.addEventListener("dragover", (event) => { event.preventDefault(); article.classList.add("drop-target"); event.dataTransfer.dropEffect = "move"; });
    article.addEventListener("dragleave", () => article.classList.remove("drop-target"));
    article.addEventListener("drop", async (event) => {
      event.preventDefault();
      article.classList.remove("drop-target");
      let paths = [];
      try { paths = JSON.parse(event.dataTransfer.getData("application/x-mindfile-paths")); } catch { paths = [event.dataTransfer.getData("text/plain")]; }
      paths = paths.filter((itemPath) => itemPath && normalizePath(itemPath) !== normalizePath(node.path));
      if (!paths.length || !confirm(`确认将所选 ${paths.length} 项移动到“${node.name}”吗？`)) return;
      await performBatch("move", paths, node.path);
    });
  }
  return article;
}

function renderGraph() {
  if (!state.root) return;
  const layout = layoutGraph();
  state.layout = layout;
  elements.stage.style.width = `${layout.width}px`;
  elements.stage.style.height = `${layout.height}px`;
  elements.edges.setAttribute("width", layout.width);
  elements.edges.setAttribute("height", layout.height);
  elements.edges.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  elements.edges.replaceChildren(...layout.nodes.map(createEdge).filter(Boolean));
  elements.nodesLayer.replaceChildren(...layout.nodes.map(createGraphNode));
  const pending = layout.nodes.filter((node) => node.hasMore).reduce((sum, node) => sum + Math.max(0, node.total - node.children.length), 0);
  elements.loadNotice.classList.toggle("hidden", pending === 0);
  if (pending) elements.loadNotice.textContent = `大型目录已分批读取，尚有 ${pending} 项未显示。点击文件夹节点上的“再加载”继续。`;
  applyTransform();
}

function applyTransform() {
  elements.stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  elements.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  drawMinimap();
}

function fitGraph() {
  if (!state.root) return;
  const rect = elements.viewport.getBoundingClientRect();
  state.zoom = Math.min(1, Math.max(0.42, Math.min(rect.width / Math.min(state.layout?.width || 1380, 1800), rect.height / Math.min(state.layout?.height || 900, 1300))));
  state.pan = {
    x: rect.width / 2 - (state.root.x + ROOT_WIDTH / 2) * state.zoom,
    y: rect.height / 2 - (state.root.y + ROOT_HEIGHT / 2) * state.zoom,
  };
  applyTransform();
}

function locateSelected() {
  if (!state.selected) return;
  const rect = elements.viewport.getBoundingClientRect();
  state.pan = {
    x: rect.width / 2 - (state.selected.x + (state.selected.depth === 0 ? ROOT_WIDTH : NODE_WIDTH) / 2) * state.zoom,
    y: rect.height / 2 - (state.selected.y + NODE_HEIGHT / 2) * state.zoom,
  };
  applyTransform();
}

function drawMinimap() {
  const canvas = elements.minimap;
  if (!canvas || !state.layout) return;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 7;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#f7f4ec";
  context.fillRect(0, 0, width, height);
  const scale = Math.min((width - pad * 2) / state.layout.width, (height - pad * 2) / state.layout.height);
  const offsetX = (width - state.layout.width * scale) / 2;
  const offsetY = (height - state.layout.height * scale) / 2;
  for (const node of state.layout.nodes) {
    context.fillStyle = normalizePath(node.path) === normalizePath(state.selected?.path) ? "#dd704f" : COLORS[node.branch % COLORS.length];
    context.fillRect(offsetX + node.x * scale, offsetY + node.y * scale, Math.max(2, NODE_WIDTH * scale), Math.max(2, NODE_HEIGHT * scale));
  }
  const view = elements.viewport.getBoundingClientRect();
  const worldX = -state.pan.x / state.zoom;
  const worldY = -state.pan.y / state.zoom;
  context.strokeStyle = "#30362f";
  context.lineWidth = 1.5;
  context.strokeRect(offsetX + worldX * scale, offsetY + worldY * scale, view.width / state.zoom * scale, view.height / state.zoom * scale);
}

function resetRenameEditor(resetValue = true) {
  elements.nameRow.classList.remove("renaming", "rename-error");
  elements.nameInput.readOnly = true;
  elements.renameButton.textContent = "重命名";
  if (resetValue && state.selected) elements.nameInput.value = state.selected.name;
}

function beginRename() {
  const nodes = selectedNodes();
  const node = nodes.length === 1 ? nodes[0] : null;
  if (!node) return;
  elements.nameRow.classList.remove("rename-error");
  elements.nameRow.classList.add("renaming");
  elements.nameInput.readOnly = false;
  elements.renameButton.textContent = "确认";
  elements.nameInput.focus();
  const dot = node.type === "file" ? node.name.lastIndexOf(".") : -1;
  elements.nameInput.setSelectionRange(0, dot > 0 ? dot : node.name.length);
}

async function showInspector(node) {
  if (!node) return;
  resetRenameEditor(false);
  const count = selectedNodes().length || 1;
  elements.inspector.querySelector(".inspector-empty").classList.add("hidden");
  elements.inspectorContent.classList.remove("hidden");
  elements.selectedCount.classList.toggle("hidden", count <= 1);
  elements.selectedCount.textContent = `已选择 ${count} 个项目；复制、移动和回收会批量执行。`;
  elements.nameInput.value = count > 1 ? `${count} 个项目` : node.name;
  elements.pathInput.value = node.path;
  elements.metaType.textContent = count > 1 ? "多项选择" : node.type === "folder" ? "文件夹" : node.type === "link" ? "快捷方式" : "文件";
  elements.metaSize.textContent = count > 1 ? formatSize(selectedNodes().reduce((sum, item) => sum + (item.size || 0), 0)) : formatSize(node.size);
  elements.metaModified.textContent = count > 1 ? "—" : new Date(node.modified).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  elements.metaExtension.textContent = count > 1 ? "—" : node.extension || "—";
  elements.fullPath.textContent = count > 1 ? selectedNodes().map((item) => item.path).join("\n") : node.path;
  elements.newFolderButton.classList.toggle("hidden", count > 1 || node.type !== "folder");
  elements.pasteButton.classList.toggle("hidden", count > 1 || node.type !== "folder" || !state.clipboard.paths.length);
  elements.trashButton.classList.toggle("hidden", !selectedNodes().length);
  elements.copyButton.classList.toggle("hidden", !selectedNodes().length);
  elements.moveButton.classList.toggle("hidden", !selectedNodes().length);
  elements.renameButton.disabled = count !== 1 || node.depth === 0;
  elements.preview.replaceChildren();
  if (count > 1) {
    const badge = document.createElement("div");
    badge.className = "multi-preview";
    badge.innerHTML = `<strong>${count}</strong><span>个项目</span>`;
    elements.preview.appendChild(badge);
    return;
  }
  const requestedPath = node.path;
  try {
    const result = await window.mindfile.preview(node.path);
    if (normalizePath(state.selected?.path) !== normalizePath(requestedPath) || selectedNodes().length > 1) return;
    if (result.kind === "image") {
      const image = document.createElement("img"); image.src = result.dataUrl; image.alt = node.name; elements.preview.appendChild(image);
    } else if (result.kind === "text") {
      const pre = document.createElement("pre"); pre.textContent = result.text; elements.preview.appendChild(pre);
    } else {
      const dataUrl = node.type !== "folder" || node.depth === 0
        ? await window.mindfile.getIcon(node.path).catch(() => null)
        : null;
      if (dataUrl) {
        const image = document.createElement("img"); image.src = dataUrl; image.alt = node.name; image.className = "system-preview-icon"; elements.preview.appendChild(image);
      } else {
        const icon = document.createElement("div"); icon.className = `preview-icon ${node.type === "folder" ? "folder" : "file"}`; if (node.type !== "folder") icon.textContent = extensionLabel(node); elements.preview.appendChild(icon);
      }
    }
  } catch {
    const icon = document.createElement("div"); icon.className = `preview-icon ${node.type === "folder" ? "folder" : "file"}`; elements.preview.appendChild(icon);
  }
}

async function chooseFolder() {
  const selected = await window.mindfile.chooseFolder();
  if (selected) await openRoot(selected);
}

async function goToAddress() {
  const target = elements.pathInput.value.trim();
  if (!target) return;
  setBusy(true, "正在打开位置…");
  try {
    const info = await window.mindfile.getInfo(target);
    if (info.type === "folder") await openRoot(info.path);
    else {
      const parent = parentPathOf(info.path);
      if (!state.root || !pathIsInside(info.path, state.root.path)) await openRoot(parent);
      const visible = await revealPath(info.path);
      if (visible) { selectOnly(visible); renderGraph(); await showInspector(visible); locateSelected(); }
      else await window.mindfile.open(info.path);
    }
  } catch (error) { showToast(error.message || "无法打开这个位置", true); }
  finally { setBusy(false); }
}

function removeFromParent(node) {
  if (node?.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
}

function updateNodeFromInfo(node, info) {
  const previousPath = node.path;
  const nextPath = info.path;
  Object.assign(node, info);
  const oldSelected = [...state.selectedPaths];
  state.selectedPaths = new Set(oldSelected.map((itemPath) => normalizePath(itemPath) === normalizePath(previousPath) ? nextPath : itemPath));
  const updateChildren = (parent) => parent.children.forEach((child) => {
    if (normalizePath(child.path).startsWith(`${normalizePath(previousPath)}\\`)) child.path = `${nextPath}${child.path.slice(previousPath.length)}`;
    updateChildren(child);
  });
  updateChildren(node);
}

async function ensureFolderVisible(folderPath) {
  let existing = findNode(folderPath);
  if (existing) { existing.expanded = true; return existing; }
  if (!state.root || !pathIsInside(folderPath, state.root.path)) return null;
  const rootPath = state.root.path.replace(/[\\/]+$/, "");
  const relative = folderPath.slice(rootPath.length).replace(/^[\\/]+/, "");
  const parts = relative ? relative.split(/[\\/]+/) : [];
  let current = state.root;
  for (const part of parts) {
    if (!current.loaded) await loadChildren(current, true);
    else current.expanded = true;
    let next = current.children.find((child) => child.type === "folder" && child.name.toLocaleLowerCase() === part.toLocaleLowerCase());
    while (!next && current.hasMore) {
      await loadChildren(current, true, true);
      next = current.children.find((child) => child.type === "folder" && child.name.toLocaleLowerCase() === part.toLocaleLowerCase());
    }
    if (!next) return null;
    current = next;
  }
  current.expanded = true;
  return current;
}

async function revealPath(itemPath) {
  const parent = await ensureFolderVisible(parentPathOf(itemPath));
  if (!parent) return null;
  if (!parent.loaded) await loadChildren(parent, true);
  let found = parent.children.find((child) => normalizePath(child.path) === normalizePath(itemPath));
  while (!found && parent.hasMore) {
    await loadChildren(parent, true, true);
    found = parent.children.find((child) => normalizePath(child.path) === normalizePath(itemPath));
  }
  reindexTree();
  return found;
}

async function showItemAtDestination(sourceNode, itemInfo, destinationPath, isCopy) {
  if (!state.root || !pathIsInside(destinationPath, state.root.path)) return;
  const destinationNode = await ensureFolderVisible(destinationPath);
  if (!destinationNode) return;
  if (!destinationNode.loaded) await loadChildren(destinationNode, true);
  destinationNode.expanded = true;
  let displayed = destinationNode.children.find((child) => normalizePath(child.path) === normalizePath(itemInfo.path));
  if (isCopy || !sourceNode) {
    if (!displayed) { displayed = makeNode(itemInfo, destinationNode, destinationNode.depth + 1, destinationNode.branch); destinationNode.children.push(displayed); }
  } else {
    removeFromParent(sourceNode);
    if (displayed && displayed !== sourceNode) destinationNode.children = destinationNode.children.filter((child) => child !== displayed);
    updateNodeFromInfo(sourceNode, itemInfo);
    sourceNode.parent = destinationNode;
    destinationNode.children.push(sourceNode);
    displayed = sourceNode;
  }
  sortChildren(destinationNode);
  reindexTree();
  return displayed;
}

function pushOperation(operation) {
  const record = { ...operation, id: `${Date.now()}-${Math.random()}`, time: Date.now(), undone: false };
  state.operations.unshift(record);
  if (state.operations.length > 30) {
    const removed = state.operations.pop();
    if (removed?.type === "trash") removed.items.forEach((item) => window.mindfile.commitTrash(item.token).catch(() => {}));
  }
  state.operationLog.unshift({ label: record.label, time: record.time, undone: false });
  state.operationLog = state.operationLog.slice(0, 30);
  writeStorage("mindfile.operationLog", state.operationLog);
  renderOperationHistory();
}

function renderOperationHistory() {
  const display = state.operations.length ? state.operations : state.operationLog;
  elements.undoButton.disabled = !state.operations.some((item) => !item.undone);
  if (!display.length) {
    elements.operationHistoryList.innerHTML = '<p class="side-empty">尚无文件操作</p>';
    return;
  }
  elements.operationHistoryList.replaceChildren(...display.slice(0, 8).map((item) => {
    const row = document.createElement("div");
    row.className = `operation-item ${item.undone ? "undone" : ""}`;
    const text = document.createElement("span"); text.textContent = item.label;
    const time = document.createElement("time"); time.textContent = new Date(item.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    row.append(text, time);
    return row;
  }));
}

async function undoLastOperation() {
  const operation = state.operations.find((item) => !item.undone);
  if (!operation) { showToast("没有可撤销的操作"); return; }
  setBusy(true, `正在撤销：${operation.label}`);
  state.suppressWatchUntil = Date.now() + 1800;
  try {
    if (operation.type === "rename") {
      await window.mindfile.rename(operation.currentPath, baseNameOf(operation.oldPath));
    } else if (operation.type === "create") {
      const staged = await window.mindfile.trash(operation.path);
      await window.mindfile.commitTrash(staged.token);
    } else if (operation.type === "move") {
      for (const item of [...operation.items].reverse()) {
        const result = await window.mindfile.move(item.to, parentPathOf(item.from));
        if (result.canceled) throw new Error("撤销已取消");
      }
    } else if (operation.type === "copy") {
      for (const item of operation.items) {
        const staged = await window.mindfile.trash(item.to);
        await window.mindfile.commitTrash(staged.token);
      }
    } else if (operation.type === "trash") {
      for (const item of [...operation.items].reverse()) await window.mindfile.undoTrash(item.token);
    }
    operation.undone = true;
    const log = state.operationLog.find((item) => item.label === operation.label && !item.undone);
    if (log) log.undone = true;
    writeStorage("mindfile.operationLog", state.operationLog);
    renderOperationHistory();
    await refreshRoot("撤销完成");
  } catch (error) { showToast(error.message || "撤销失败", true); }
  finally { setBusy(false); }
}

async function renameSelected() {
  const nodes = selectedNodes();
  const node = nodes.length === 1 ? nodes[0] : null;
  if (!node) return;
  if (!elements.nameRow.classList.contains("renaming")) { beginRename(); return; }
  const nextName = elements.nameInput.value.trim();
  if (!nextName) { elements.nameRow.classList.add("rename-error"); elements.nameInput.focus(); return; }
  if (nextName === node.name) { resetRenameEditor(); return; }
  const oldPath = node.path;
  setBusy(true, "正在重命名…");
  state.suppressWatchUntil = Date.now() + 1500;
  try {
    const renamed = await window.mindfile.rename(node.path, nextName);
    updateNodeFromInfo(node, renamed);
    if (node.parent) sortChildren(node.parent);
    pushOperation({ type: "rename", label: `重命名：${baseNameOf(oldPath)} → ${renamed.name}`, oldPath, currentPath: renamed.path });
    renderGraph();
    await showInspector(node);
    showToast("重命名完成，可按 Ctrl + Z 撤销");
  } catch (error) {
    elements.nameRow.classList.add("rename-error"); elements.nameInput.readOnly = false; elements.nameInput.focus(); showToast(error.message || "重命名失败", true);
  } finally { setBusy(false); }
}

async function performBatch(mode, paths, destinationPath) {
  const uniquePaths = [...new Map(paths.map((itemPath) => [normalizePath(itemPath), itemPath])).values()];
  if (!uniquePaths.length) return;
  setBusy(true, mode === "copy" ? "正在批量复制…" : "正在批量移动…");
  state.suppressWatchUntil = Date.now() + 2200;
  const completed = [];
  try {
    for (const sourcePath of uniquePaths) {
      const sourceNode = findNode(sourcePath);
      const result = mode === "copy" ? await window.mindfile.copy(sourcePath, destinationPath) : await window.mindfile.move(sourcePath, destinationPath);
      if (result.canceled) break;
      if (result.skipped) continue;
      const displayed = await showItemAtDestination(sourceNode, result.item, destinationPath, mode === "copy");
      completed.push({ from: sourcePath, to: result.item.path });
      if (displayed) state.selected = displayed;
    }
    if (completed.length) {
      state.selectedPaths = new Set(completed.map((item) => item.to));
      pushOperation({ type: mode, label: `${mode === "copy" ? "复制" : "移动"} ${completed.length} 项到 ${baseNameOf(destinationPath)}`, items: completed });
      if (mode === "move" && state.clipboard.mode === "cut") state.clipboard = { mode: null, paths: [] };
      renderGraph();
      await showInspector(state.selected || state.root);
      showToast(`${mode === "copy" ? "复制" : "移动"}完成，可按 Ctrl + Z 撤销`);
    } else showToast("没有项目被处理");
  } catch (error) { showToast(error.message || `${mode === "copy" ? "复制" : "移动"}失败`, true); }
  finally { setBusy(false); }
}

async function copySelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const destination = await window.mindfile.chooseCopyTarget(nodes[0].path);
  if (!destination || !confirm(`确认将所选 ${nodes.length} 项复制到“${destination}”吗？`)) return;
  await performBatch("copy", nodes.map((node) => node.path), destination);
}

async function moveSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const destination = await window.mindfile.chooseMoveTarget(nodes[0].path);
  if (!destination || !confirm(`确认将所选 ${nodes.length} 项移动到“${destination}”吗？`)) return;
  await performBatch("move", nodes.map((node) => node.path), destination);
}

function copySelectionToClipboard(mode) {
  const paths = selectedNodes().map((node) => node.path);
  if (!paths.length) return;
  state.clipboard = { mode, paths };
  renderGraph();
  void showInspector(state.selected);
  showToast(`${mode === "copy" ? "已复制" : "已剪切"} ${paths.length} 项，选择文件夹后按 Ctrl + V`);
}

async function pasteIntoSelected() {
  if (!state.clipboard.paths.length) return;
  const target = state.selected?.type === "folder" ? state.selected : state.selected?.parent || state.root;
  if (!target) return;
  await performBatch(state.clipboard.mode === "cut" ? "move" : "copy", state.clipboard.paths, target.path);
}

async function trashSelected() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  if (!confirm(`确认将所选 ${nodes.length} 项回收吗？\n\n可立即按 Ctrl + Z 恢复到原位置。`)) return;
  setBusy(true, "正在安全回收所选项目…");
  state.suppressWatchUntil = Date.now() + 1800;
  const records = [];
  try {
    for (const node of nodes) {
      const result = await window.mindfile.trash(node.path);
      records.push({ token: result.token, original: node.path });
      removeFromParent(node);
    }
    pushOperation({ type: "trash", label: `回收 ${records.length} 项`, items: records });
    reindexTree();
    selectOnly(nodes[0]?.parent || state.root);
    renderGraph();
    await showInspector(state.selected);
    showToast("已安全回收，可按 Ctrl + Z 恢复");
  } catch (error) { showToast(error.message || "回收失败", true); }
  finally { setBusy(false); }
}

async function createFolderInSelected() {
  const node = state.selected?.type === "folder" ? state.selected : state.selected?.parent;
  if (!node) return;
  const name = prompt("新文件夹名称：", "新建文件夹");
  if (!name) return;
  setBusy(true, "正在创建文件夹…");
  state.suppressWatchUntil = Date.now() + 1500;
  try {
    const created = await window.mindfile.createFolder(node.path, name);
    if (!node.loaded) await loadChildren(node, true);
    let createdNode = node.children.find((child) => normalizePath(child.path) === normalizePath(created.path));
    if (!createdNode) { createdNode = makeNode(created, node, node.depth + 1, node.branch); node.children.push(createdNode); }
    node.expanded = true;
    sortChildren(node);
    reindexTree();
    selectOnly(createdNode);
    pushOperation({ type: "create", label: `新建文件夹：${created.name}`, path: created.path });
    renderGraph();
    await showInspector(createdNode);
    showToast("文件夹已创建，可按 Ctrl + Z 撤销");
  } catch (error) { showToast(error.message || "创建失败", true); }
  finally { setBusy(false); }
}

async function toggleNode(node) {
  if (!node || node.type !== "folder") return;
  setBusy(true, "正在更新分支…");
  try {
    if (node.loaded) node.expanded = !node.expanded;
    else await loadChildren(node, true);
    renderGraph();
  } catch (error) { showToast(error.message || "无法读取文件夹", true); }
  finally { setBusy(false); }
}

async function toggleSelectedBranch() { await toggleNode(state.selected); }

function collapseAll() {
  if (!state.root) return;
  walkTree(state.root, (node) => { if (node !== state.root) node.expanded = false; });
  state.root.expanded = true;
  renderGraph();
  locateSelected();
}

function collapseOthers() {
  if (!state.selected) return;
  const keep = new Set();
  let current = state.selected;
  while (current) { keep.add(normalizePath(current.path)); current = current.parent; }
  walkTree(state.root, (node) => {
    if (node.type === "folder" && node !== state.root && !keep.has(normalizePath(node.path))) node.expanded = false;
  });
  state.root.expanded = true;
  renderGraph();
  locateSelected();
}

function togglePin() {
  const node = state.selected;
  if (!node) return;
  node.pinned = !node.pinned;
  if (node.pinned) { node.pinnedX = node.x; node.pinnedY = node.y; }
  savePins();
  renderGraph();
  showToast(node.pinned ? "节点位置已固定" : "已恢复自动布局");
}

function markActiveNavigation(currentPath) {
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", normalizePath(button.dataset.path) === normalizePath(currentPath)));
}

function navButton(label, itemPath, type = "folder") {
  const button = document.createElement("button");
  button.className = "nav-item";
  button.dataset.path = itemPath;
  const icon = document.createElement("i"); icon.className = `nav-icon ${type}`;
  const text = document.createElement("span"); text.textContent = label;
  button.append(icon, text);
  button.addEventListener("click", () => openRoot(itemPath));
  return button;
}

function addFavorite() {
  const node = state.selected || state.root;
  if (!node) return;
  if (state.favorites.some((item) => normalizePath(item.path) === normalizePath(node.path))) { showToast("这个位置已经在收藏中"); return; }
  state.favorites.push({ name: node.name, path: node.path, type: node.type });
  writeStorage("mindfile.favorites", state.favorites);
  renderSavedLocations();
  showToast("已添加到收藏");
}

function saveWorkspace() {
  if (!state.root) return;
  const name = prompt("工作区名称：", state.root.name || "我的工作区");
  if (!name) return;
  state.workspaces.push({
    id: `${Date.now()}-${Math.random()}`, name, rootPath: state.root.path, expanded: collectExpandedPaths(), pan: state.pan, zoom: state.zoom,
  });
  writeStorage("mindfile.workspaces", state.workspaces);
  renderSavedLocations();
  showToast("工作区已保存；它只保存视图，不改变磁盘结构");
}

async function openWorkspace(workspace) {
  await openRoot(workspace.rootPath, true, false);
  const expanded = new Set((workspace.expanded || []).map(normalizePath));
  await restoreExpandedNodes(state.root, expanded);
  reindexTree();
  renderGraph();
  state.zoom = workspace.zoom || 0.9;
  state.pan = workspace.pan || { x: 0, y: 0 };
  applyTransform();
}

function savedRow(item, kind, index) {
  const row = document.createElement("div"); row.className = "saved-item";
  const open = document.createElement("button"); open.className = "saved-open";
  open.innerHTML = `<i>${kind === "favorite" ? "☆" : "◇"}</i><span></span>`;
  open.querySelector("span").textContent = item.name;
  open.title = item.path || item.rootPath;
  open.addEventListener("click", async () => {
    if (kind === "workspace") { await openWorkspace(item); return; }
    try {
      const info = await window.mindfile.getInfo(item.path);
      if (info.type === "folder") await openRoot(info.path);
      else {
        await openRoot(parentPathOf(info.path));
        const node = await revealPath(info.path);
        if (node) { selectOnly(node); renderGraph(); await showInspector(node); locateSelected(); }
      }
    } catch (error) { showToast(error.message || "收藏位置已不存在", true); }
  });
  const remove = document.createElement("button"); remove.className = "saved-remove"; remove.textContent = "×"; remove.title = "移除";
  remove.addEventListener("click", () => {
    if (kind === "favorite") state.favorites.splice(index, 1); else state.workspaces.splice(index, 1);
    writeStorage(kind === "favorite" ? "mindfile.favorites" : "mindfile.workspaces", kind === "favorite" ? state.favorites : state.workspaces);
    renderSavedLocations();
  });
  row.append(open, remove);
  return row;
}

function renderSavedLocations() {
  elements.favoritesList.replaceChildren(...(state.favorites.length ? state.favorites.map((item, index) => savedRow(item, "favorite", index)) : [emptySide("暂无收藏")]));
  elements.workspaceList.replaceChildren(...(state.workspaces.length ? state.workspaces.map((item, index) => savedRow(item, "workspace", index)) : [emptySide("暂无工作区")]));
}

function emptySide(text) { const p = document.createElement("p"); p.className = "side-empty"; p.textContent = text; return p; }

async function runFullSearch() {
  if (!state.root) return;
  const query = elements.searchInput.value.trim();
  const filters = { kind: elements.searchType.value, size: elements.searchSize.value, days: elements.searchModified.value };
  if (!query && filters.kind === "all" && filters.size === "all" && !Number(filters.days)) { showToast("请输入关键词或选择筛选条件"); return; }
  setBusy(true, "正在后台搜索整个当前位置…");
  try {
    const result = await window.mindfile.search(state.root.path, query, filters);
    state.search = query.toLocaleLowerCase();
    state.searchResults = new Set(result.results.map((item) => normalizePath(item.path)));
    state.searchInfo = new Map(result.results.map((item) => [normalizePath(item.path), item]));
    state.searchPaths.clear();
    for (const item of result.results) {
      let current = item.path;
      while (pathIsInside(current, state.root.path) && normalizePath(current) !== normalizePath(state.root.path)) {
        state.searchPaths.add(normalizePath(current));
        const parent = parentPathOf(current);
        if (parent === current) break;
        current = parent;
      }
    }
    state.searchPaths.add(normalizePath(state.root.path));
    for (const item of result.results.slice(0, 20)) {
      try { await revealPath(item.path); } catch { /* Search result can change while revealing. */ }
    }
    renderGraph();
    elements.searchStatus.textContent = `找到 ${result.results.length} 项 · 已扫描 ${result.scanned.toLocaleString("zh-CN")} 项${result.limited ? " · 已达显示上限" : ""}`;
    if (result.results.length) {
      const first = findNode(result.results[0].path);
      if (first) { selectOnly(first); renderGraph(); await showInspector(first); locateSelected(); }
    } else showToast("没有找到符合条件的项目");
  } catch (error) { showToast(error.message || "搜索失败", true); }
  finally { setBusy(false); }
}

function clearSearch() {
  state.search = "";
  state.searchResults.clear(); state.searchPaths.clear(); state.searchInfo.clear();
  elements.searchInput.value = ""; elements.searchStatus.textContent = "";
  renderGraph();
}

async function initialize() {
  renderSavedLocations();
  renderOperationHistory();
  try {
    const system = await window.mindfile.getLocations();
    elements.quickAccess.append(
      navButton("主文件夹", system.locations.home), navButton("桌面", system.locations.desktop),
      navButton("文档", system.locations.documents), navButton("下载", system.locations.downloads),
    );
    elements.driveList.append(...system.drives.map((drive) => navButton(drive.name, drive.path, "drive")));
    elements.welcome.classList.remove("hidden");
    elements.pathInput.value = system.locations.home;
  } catch (error) { showToast(error.message || "无法读取本机位置", true); }
}

elements.chooseFolderButton.addEventListener("click", chooseFolder);
elements.welcomeChooseButton.addEventListener("click", chooseFolder);
elements.goButton.addEventListener("click", goToAddress);
elements.pathInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void goToAddress(); });
elements.refreshButton.addEventListener("click", () => refreshRoot());
elements.backButton.addEventListener("click", async () => {
  const previous = state.navHistory.pop();
  if (previous) await openRoot(previous, false);
  elements.backButton.disabled = state.navHistory.length === 0;
});
elements.upButton.addEventListener("click", () => {
  if (!state.root) return;
  const parent = parentPathOf(state.root.path);
  if (normalizePath(parent) !== normalizePath(state.root.path)) void openRoot(parent);
});
elements.searchInput.addEventListener("input", (event) => { state.search = event.target.value.trim().toLocaleLowerCase(); renderGraph(); });
elements.searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void runFullSearch(); });
elements.searchButton.addEventListener("click", runFullSearch);
elements.clearSearchButton.addEventListener("click", clearSearch);
elements.addFavoriteButton.addEventListener("click", addFavorite);
elements.favoriteButton.addEventListener("click", addFavorite);
elements.saveWorkspaceButton.addEventListener("click", saveWorkspace);
elements.undoButton.addEventListener("click", undoLastOperation);

document.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName;
  const typing = activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT";
  const key = event.key.toLocaleLowerCase();
  if (event.ctrlKey && key === "k") { event.preventDefault(); elements.searchInput.focus(); return; }
  if (typing) return;
  if (event.ctrlKey && key === "z") { event.preventDefault(); void undoLastOperation(); }
  else if (event.ctrlKey && key === "c") { event.preventDefault(); copySelectionToClipboard("copy"); }
  else if (event.ctrlKey && key === "x") { event.preventDefault(); copySelectionToClipboard("cut"); }
  else if (event.ctrlKey && key === "v") { event.preventDefault(); void pasteIntoSelected(); }
  else if (event.ctrlKey && key === "a" && state.layout) {
    event.preventDefault();
    state.selectedPaths = new Set(state.layout.nodes.filter((node) => node.depth > 0).map((node) => node.path));
    state.selected = selectedNodes()[0] || state.root; renderGraph(); void showInspector(state.selected);
  } else if (event.key === "F2") { event.preventDefault(); beginRename(); }
  else if (event.key === "Enter" && state.selected) {
    event.preventDefault();
    if (state.selected.type === "folder") void toggleSelectedBranch(); else window.mindfile.open(state.selected.path).catch((error) => showToast(error.message, true));
  } else if (event.key === "Delete" && selectedNodes().length) { event.preventDefault(); void trashSelected(); }
  else if (event.ctrlKey && event.shiftKey && key === "n") { event.preventDefault(); void createFolderInSelected(); }
  else if (event.key === "F5" && state.root) { event.preventDefault(); void refreshRoot(); }
});

function stopPointerAction(pointerId) {
  if (state.draggingNode && (pointerId === undefined || state.draggingNode.pointerId === pointerId)) {
    const node = state.draggingNode.node;
    node.pinned = true; node.pinnedX = node.x; node.pinnedY = node.y;
    state.draggingNode = null; elements.viewport.classList.remove("dragging-node"); savePins(); renderGraph();
  }
  if (state.selecting && (pointerId === undefined || state.selecting.pointerId === pointerId)) {
    const boxRect = elements.selectionBox.getBoundingClientRect();
    const paths = [];
    document.querySelectorAll(".graph-node:not(.root)").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.right >= boxRect.left && rect.left <= boxRect.right && rect.bottom >= boxRect.top && rect.top <= boxRect.bottom) paths.push(element.dataset.path);
    });
    state.selecting = null; elements.selectionBox.classList.add("hidden");
    if (paths.length) { state.selectedPaths = new Set(paths); state.selected = findNode(paths[paths.length - 1]); renderGraph(); void showInspector(state.selected); }
  }
  if (state.panning && (pointerId === undefined || state.panning.pointerId === pointerId)) {
    state.panning = null; elements.viewport.classList.remove("panning");
  }
  if (pointerId !== undefined && elements.viewport.hasPointerCapture(pointerId)) elements.viewport.releasePointerCapture(pointerId);
}

elements.viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const nodeElement = event.target.closest(".graph-node");
  if (event.altKey && nodeElement) {
    const node = findNode(nodeElement.dataset.path);
    if (!node) return;
    event.preventDefault();
    state.draggingNode = { pointerId: event.pointerId, node, element: nodeElement, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y };
    elements.viewport.classList.add("dragging-node");
    elements.viewport.setPointerCapture(event.pointerId);
    return;
  }
  const interactive = event.target.closest(".graph-node, button, input, select, .zoom-controls, .graph-tools, .minimap-wrap, .load-notice");
  if (interactive || state.panning || state.selecting) return;
  event.preventDefault();
  const rect = elements.viewport.getBoundingClientRect();
  if (event.shiftKey) {
    state.selecting = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.clientX - rect.left, top: event.clientY - rect.top };
    Object.assign(elements.selectionBox.style, { left: `${state.selecting.left}px`, top: `${state.selecting.top}px`, width: "0px", height: "0px" });
    elements.selectionBox.classList.remove("hidden");
  } else {
    state.panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: state.pan.x, panY: state.pan.y };
    elements.viewport.classList.add("panning");
  }
  elements.viewport.setPointerCapture(event.pointerId);
});

elements.viewport.addEventListener("pointermove", (event) => {
  if (state.draggingNode?.pointerId === event.pointerId) {
    const drag = state.draggingNode;
    drag.node.x = Math.max(12, drag.x + (event.clientX - drag.clientX) / state.zoom);
    drag.node.y = Math.max(12, drag.y + (event.clientY - drag.clientY) / state.zoom);
    drag.element.style.left = `${drag.node.x}px`; drag.element.style.top = `${drag.node.y}px`;
    return;
  }
  if (state.selecting?.pointerId === event.pointerId) {
    const rect = elements.viewport.getBoundingClientRect();
    const currentX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const currentY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const left = Math.min(state.selecting.left, currentX); const top = Math.min(state.selecting.top, currentY);
    Object.assign(elements.selectionBox.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(currentX - state.selecting.left)}px`, height: `${Math.abs(currentY - state.selecting.top)}px` });
    return;
  }
  if (state.panning?.pointerId === event.pointerId) {
    if ((event.buttons & 1) === 0) { stopPointerAction(event.pointerId); return; }
    state.pan.x = state.panning.panX + event.clientX - state.panning.x;
    state.pan.y = state.panning.panY + event.clientY - state.panning.y;
    applyTransform();
  }
});
elements.viewport.addEventListener("pointerup", (event) => stopPointerAction(event.pointerId));
elements.viewport.addEventListener("pointercancel", (event) => stopPointerAction(event.pointerId));
elements.viewport.addEventListener("lostpointercapture", (event) => stopPointerAction(event.pointerId));
elements.viewport.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".graph-node")) return;
  event.preventDefault();
  if (!state.root) return;
  window.mindfile.showContextMenu({ background: true, canPaste: state.clipboard.paths.length > 0, canUndo: state.operations.some((item) => !item.undone) });
});
elements.viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const before = state.zoom;
  state.zoom = Math.min(1.55, Math.max(0.38, state.zoom - event.deltaY * 0.001));
  const rect = elements.viewport.getBoundingClientRect();
  const x = event.clientX - rect.left; const y = event.clientY - rect.top;
  state.pan.x = x - (x - state.pan.x) * (state.zoom / before);
  state.pan.y = y - (y - state.pan.y) * (state.zoom / before);
  applyTransform();
}, { passive: false });

elements.zoomIn.addEventListener("click", () => { state.zoom = Math.min(1.55, state.zoom + 0.1); applyTransform(); });
elements.zoomOut.addEventListener("click", () => { state.zoom = Math.max(0.38, state.zoom - 0.1); applyTransform(); });
elements.fitButton.addEventListener("click", fitGraph);
elements.centerButton.addEventListener("click", fitGraph);
elements.locateButton.addEventListener("click", locateSelected);
elements.collapseOthersButton.addEventListener("click", collapseOthers);
elements.collapseAllButton.addEventListener("click", collapseAll);
elements.minimap.addEventListener("click", (event) => {
  if (!state.layout) return;
  const rect = elements.minimap.getBoundingClientRect();
  const scale = Math.min((elements.minimap.width - 14) / state.layout.width, (elements.minimap.height - 14) / state.layout.height);
  const offsetX = (elements.minimap.width - state.layout.width * scale) / 2;
  const offsetY = (elements.minimap.height - state.layout.height * scale) / 2;
  const worldX = ((event.clientX - rect.left) * elements.minimap.width / rect.width - offsetX) / scale;
  const worldY = ((event.clientY - rect.top) * elements.minimap.height / rect.height - offsetY) / scale;
  const viewportRect = elements.viewport.getBoundingClientRect();
  state.pan = { x: viewportRect.width / 2 - worldX * state.zoom, y: viewportRect.height / 2 - worldY * state.zoom };
  applyTransform();
});

elements.openButton.addEventListener("click", async () => { if (state.selected) try { await window.mindfile.open(state.selected.path); } catch (error) { showToast(error.message, true); } });
elements.revealButton.addEventListener("click", async () => { if (state.selected) await window.mindfile.reveal(state.selected.path); });
elements.copyPathButton.addEventListener("click", async () => { if (state.selected) { await window.mindfile.copyPath(state.selected.path); showToast("路径已复制"); } });
elements.renameButton.addEventListener("click", renameSelected);
elements.nameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") void renameSelected(); else if (event.key === "Escape") resetRenameEditor(); });
elements.copyButton.addEventListener("click", copySelected);
elements.moveButton.addEventListener("click", moveSelected);
elements.trashButton.addEventListener("click", trashSelected);
elements.newFolderButton.addEventListener("click", createFolderInSelected);
elements.pasteButton.addEventListener("click", pasteIntoSelected);
elements.propertiesButton.addEventListener("click", () => state.selected && window.mindfile.properties(state.selected.path));

window.mindfile.onFileChanged(() => {
  if (!state.root || Date.now() < state.suppressWatchUntil) return;
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => void refreshRoot("", true), 650);
});

window.mindfile.onContextCommand(async (command) => {
  const node = state.selected;
  if (!node) return;
  if (command === "open-map" && node.type === "folder") await openRoot(node.path);
  else if (command === "open") try { await window.mindfile.open(node.path); } catch (error) { showToast(error.message, true); }
  else if (command === "toggle-branch") await toggleSelectedBranch();
  else if (command === "reveal") await window.mindfile.reveal(node.path);
  else if (command === "new-folder") await createFolderInSelected();
  else if (command === "copy") copySelectionToClipboard("copy");
  else if (command === "cut") copySelectionToClipboard("cut");
  else if (command === "paste") await pasteIntoSelected();
  else if (command === "copy-to") await copySelected();
  else if (command === "move-to") await moveSelected();
  else if (command === "copy-path") { await window.mindfile.copyPath(node.path); showToast("路径已复制"); }
  else if (command === "rename") beginRename();
  else if (command === "trash") await trashSelected();
  else if (command === "undo") await undoLastOperation();
  else if (command === "refresh") await refreshRoot();
  else if (command === "fit") fitGraph();
  else if (command === "locate") locateSelected();
  else if (command === "collapse-others") collapseOthers();
  else if (command === "collapse-all") collapseAll();
  else if (command === "favorite") addFavorite();
  else if (command === "save-workspace") saveWorkspace();
  else if (command === "toggle-pin") togglePin();
  else if (command === "properties") await window.mindfile.properties(node.path);
});

initialize();
