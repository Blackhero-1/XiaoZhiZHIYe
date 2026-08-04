const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, nativeImage, Menu } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PAGE_SIZE = 120;
const MAX_PAGE_SIZE = 240;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_ITEMS = 80000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx", ".css", ".html", ".xml", ".csv", ".log",
  ".py", ".java", ".cs", ".cpp", ".c", ".h", ".ini", ".yml", ".yaml", ".toml", ".sql", ".ps1",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".wma"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"]);
const thumbnailCache = new Map();
const iconCache = new Map();
const watchers = new Map();
const pendingTrash = new Map();

function createWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#f4f1e9",
    title: "小智枝叶文件管理器 v1.0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile("index.html");
  return window;
}

app.whenReady().then(async () => {
  await cleanupOldUndoTrash();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  watchers.forEach((watcher) => watcher.close());
  watchers.clear();
  if (process.platform !== "darwin") app.quit();
});

function checkedPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32767) throw new Error("路径无效");
  return path.resolve(value);
}

function safeName(value) {
  const name = String(value ?? "").trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*]/.test(name)) {
    throw new Error("名称为空或包含 Windows 不允许的字符");
  }
  return name;
}

function typeFromStat(stat) {
  if (stat.isDirectory()) return "folder";
  if (stat.isSymbolicLink()) return "link";
  return "file";
}

async function describeItem(itemPath, knownDirent) {
  const resolved = checkedPath(itemPath);
  const stat = await fsp.lstat(resolved);
  const type = knownDirent?.isDirectory() ? "folder" : typeFromStat(stat);
  return {
    path: resolved,
    name: path.basename(resolved) || resolved,
    type,
    extension: type === "file" ? path.extname(resolved).toLowerCase() : "",
    size: type === "file" ? stat.size : 0,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    hidden: path.basename(resolved).startsWith("."),
  };
}

async function exists(itemPath) {
  try { await fsp.access(itemPath); return true; } catch { return false; }
}

function cachePut(cache, key, value, max = 320) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
  return value;
}

ipcMain.handle("system:locations", async () => {
  const locations = {
    home: app.getPath("home"), desktop: app.getPath("desktop"), documents: app.getPath("documents"), downloads: app.getPath("downloads"),
  };
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      await fsp.access(root, fs.constants.R_OK);
      drives.push({ path: root, name: `${String.fromCharCode(code)} 盘` });
    } catch { /* Missing and inaccessible drive letters are normal. */ }
  }
  return { locations, drives };
});

ipcMain.handle("dialog:choose-folder", async () => {
  const result = await dialog.showOpenDialog({ title: "选择要浏览的磁盘或文件夹", properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("fs:info", async (_event, itemPath) => describeItem(itemPath));

ipcMain.handle("fs:list", async (_event, directoryPath, options = {}) => {
  const resolved = checkedPath(directoryPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error("这不是文件夹");
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(20, Number(options.limit) || PAGE_SIZE));
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
  const page = entries.slice(offset, offset + limit);
  const items = [];
  for (const entry of page) {
    try { items.push(await describeItem(path.join(resolved, entry.name), entry)); } catch { /* Entry changed during enumeration. */ }
  }
  const nextOffset = Math.min(entries.length, offset + page.length);
  return { items, total: entries.length, offset, nextOffset, hasMore: nextOffset < entries.length };
});

ipcMain.handle("fs:icon", async (_event, itemPath) => {
  const resolved = checkedPath(itemPath);
  const key = `${resolved.toLowerCase()}|icon`;
  if (iconCache.has(key)) return iconCache.get(key);
  try {
    const image = await app.getFileIcon(resolved, { size: "normal" });
    return cachePut(iconCache, key, image.isEmpty() ? null : image.toDataURL());
  } catch { return null; }
});

ipcMain.handle("fs:preview", async (_event, itemPath) => {
  const resolved = checkedPath(itemPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) return { kind: "none" };
  const cacheKey = `${resolved.toLowerCase()}|${stat.mtimeMs}|${stat.size}`;
  if (thumbnailCache.has(cacheKey)) return thumbnailCache.get(cacheKey);
  const extension = path.extname(resolved).toLowerCase();
  let result = { kind: "none" };
  if (IMAGE_EXTENSIONS.has(extension) && extension !== ".svg" && stat.size <= 15 * 1024 * 1024) {
    const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : `image/${extension.slice(1)}`;
    const data = await fsp.readFile(resolved);
    result = { kind: "image", dataUrl: `data:${mime};base64,${data.toString("base64")}` };
  } else if (TEXT_EXTENSIONS.has(extension) && stat.size <= 2 * 1024 * 1024) {
    const handle = await fsp.open(resolved, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 120000));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      result = { kind: "text", text: buffer.subarray(0, bytesRead).toString("utf8") };
    } finally { await handle.close(); }
  } else {
    try {
      const image = await nativeImage.createThumbnailFromPath(resolved, { width: 460, height: 300 });
      if (!image.isEmpty()) result = { kind: "image", dataUrl: image.toDataURL() };
    } catch { /* Windows has no thumbnail provider for every type. */ }
  }
  return cachePut(thumbnailCache, cacheKey, result, 180);
});

ipcMain.handle("fs:open", async (_event, itemPath) => {
  const error = await shell.openPath(checkedPath(itemPath));
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle("fs:reveal", async (_event, itemPath) => { shell.showItemInFolder(checkedPath(itemPath)); return true; });
ipcMain.handle("fs:copy-path", async (_event, itemPath) => { clipboard.writeText(checkedPath(itemPath)); return true; });

ipcMain.handle("fs:properties", async (_event, itemPath) => {
  const resolved = checkedPath(itemPath);
  if (path.dirname(resolved) === resolved) {
    await shell.openPath(resolved);
    return true;
  }
  const literal = resolved.replace(/'/g, "''");
  const script = `$target='${literal}';$parent=Split-Path -LiteralPath $target;$name=Split-Path -Leaf -LiteralPath $target;$s=New-Object -ComObject Shell.Application;$f=$s.Namespace($parent);$i=$f.ParseName($name);if($i){$i.InvokeVerb('properties')}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return true;
});

ipcMain.handle("fs:create-folder", async (_event, parentPath, folderName) => {
  const destination = path.join(checkedPath(parentPath), safeName(folderName));
  await fsp.mkdir(destination, { recursive: false });
  return describeItem(destination);
});

ipcMain.handle("fs:rename", async (_event, itemPath, newName) => {
  const source = checkedPath(itemPath);
  const destination = path.join(path.dirname(source), safeName(newName));
  if (destination.toLowerCase() === source.toLowerCase()) return describeItem(source);
  if (await exists(destination)) throw new Error("同一位置已经存在同名文件或文件夹");
  await fsp.rename(source, destination);
  return describeItem(destination);
});

ipcMain.handle("fs:choose-move-target", async (_event, sourcePath) => {
  const source = checkedPath(sourcePath);
  const result = await dialog.showOpenDialog({ title: `移动所选项目到…`, defaultPath: path.dirname(source), properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("fs:choose-copy-target", async (_event, sourcePath) => {
  const source = checkedPath(sourcePath);
  const result = await dialog.showOpenDialog({ title: `复制所选项目到…`, defaultPath: path.dirname(source), properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

function autoRenamePath(destination) {
  const parsed = path.parse(destination);
  let index = 2;
  let candidate = destination;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function resolveConflict(event, destination) {
  if (!(await exists(destination))) return { destination, action: "normal" };
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(owner || undefined, {
    type: "warning", title: "发现同名项目", message: `目标位置已存在“${path.basename(destination)}”`,
    detail: "请选择如何处理这个同名项目。覆盖会先将旧项目放入 Windows 回收站。",
    buttons: ["自动重命名", "覆盖", "跳过", "取消"], defaultId: 0, cancelId: 3, noLink: true,
  });
  if (result.response === 3) return { canceled: true };
  if (result.response === 2) return { skipped: true };
  if (result.response === 0) return { destination: autoRenamePath(destination), action: "rename" };
  await shell.trashItem(destination);
  return { destination, action: "overwrite" };
}

async function moveItem(sourcePath, destinationDirectory, destinationOverride) {
  const source = checkedPath(sourcePath);
  const destinationRoot = checkedPath(destinationDirectory);
  const destination = destinationOverride || path.join(destinationRoot, path.basename(source));
  if (source.toLowerCase() === destination.toLowerCase()) return source;
  if (destination.toLowerCase().startsWith(`${source.toLowerCase()}${path.sep}`)) throw new Error("不能把文件夹移动到它自己的内部");
  try { await fsp.rename(source, destination); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await shell.trashItem(source);
  }
  return destination;
}

ipcMain.handle("fs:move", async (event, sourcePath, destinationDirectory) => {
  const source = checkedPath(sourcePath);
  const destinationRoot = checkedPath(destinationDirectory);
  const initial = path.join(destinationRoot, path.basename(source));
  if (source.toLowerCase() === initial.toLowerCase()) return { item: await describeItem(source), action: "normal" };
  const conflict = await resolveConflict(event, initial);
  if (conflict.canceled || conflict.skipped) return conflict;
  const movedPath = await moveItem(source, destinationRoot, conflict.destination);
  return { item: await describeItem(movedPath), action: conflict.action };
});

ipcMain.handle("fs:copy", async (event, sourcePath, destinationDirectory) => {
  const source = checkedPath(sourcePath);
  const destinationRoot = checkedPath(destinationDirectory);
  const initial = path.join(destinationRoot, path.basename(source));
  if (source.toLowerCase() === initial.toLowerCase()) throw new Error("源文件和目标文件相同");
  if (initial.toLowerCase().startsWith(`${source.toLowerCase()}${path.sep}`)) throw new Error("不能把文件夹复制到它自己的内部");
  const conflict = await resolveConflict(event, initial);
  if (conflict.canceled || conflict.skipped) return conflict;
  await fsp.cp(source, conflict.destination, { recursive: true, errorOnExist: true, force: false });
  return { item: await describeItem(conflict.destination), action: conflict.action };
});

function undoTrashRoot() { return path.join(app.getPath("userData"), "undo-trash"); }

async function cleanupOldUndoTrash() {
  const root = undoTrashRoot();
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(root, entry.name);
      try {
        const stat = await fsp.stat(target);
        if (stat.mtimeMs < cutoff) await shell.trashItem(target);
      } catch { /* Best-effort cleanup. */ }
    }
  } catch { /* Nothing staged yet. */ }
}

ipcMain.handle("fs:trash", async (_event, itemPath) => {
  const source = checkedPath(itemPath);
  const token = crypto.randomUUID();
  const container = path.join(undoTrashRoot(), token);
  const staged = path.join(container, path.basename(source));
  await fsp.mkdir(container, { recursive: true });
  try { await fsp.rename(source, staged); }
  catch (error) {
    if (error.code !== "EXDEV") { await fsp.rm(container, { recursive: true, force: true }); throw error; }
    await fsp.cp(source, staged, { recursive: true, errorOnExist: true, force: false });
    await shell.trashItem(source);
  }
  pendingTrash.set(token, { original: source, staged, container });
  return { token, original: source };
});

ipcMain.handle("fs:undo-trash", async (_event, token) => {
  const record = pendingTrash.get(String(token));
  if (!record || !(await exists(record.staged))) throw new Error("这项回收操作已无法撤销");
  if (await exists(record.original)) throw new Error("原位置已有同名项目，无法恢复");
  await fsp.mkdir(path.dirname(record.original), { recursive: true });
  try { await fsp.rename(record.staged, record.original); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.cp(record.staged, record.original, { recursive: true, errorOnExist: true, force: false });
    await shell.trashItem(record.staged);
  }
  await fsp.rm(record.container, { recursive: true, force: true });
  pendingTrash.delete(String(token));
  return describeItem(record.original);
});

ipcMain.handle("fs:commit-trash", async (_event, token) => {
  const record = pendingTrash.get(String(token));
  if (!record) return false;
  if (await exists(record.staged)) await shell.trashItem(record.staged);
  await fsp.rm(record.container, { recursive: true, force: true });
  pendingTrash.delete(String(token));
  return true;
});

function matchesKind(info, kind) {
  if (!kind || kind === "all") return true;
  if (kind === "folder") return info.type === "folder";
  if (info.type !== "file") return false;
  if (kind === "image") return IMAGE_EXTENSIONS.has(info.extension);
  if (kind === "document") return TEXT_EXTENSIONS.has(info.extension) || new Set([".doc", ".docx", ".pdf", ".xls", ".xlsx", ".ppt", ".pptx"]).has(info.extension);
  if (kind === "video") return VIDEO_EXTENSIONS.has(info.extension);
  if (kind === "audio") return AUDIO_EXTENSIONS.has(info.extension);
  if (kind === "archive") return ARCHIVE_EXTENSIONS.has(info.extension);
  return true;
}

function matchesFilters(info, filters = {}) {
  if (!matchesKind(info, filters.kind)) return false;
  if (info.type === "file" && filters.size === "small" && info.size >= 1024 * 1024) return false;
  if (info.type === "file" && filters.size === "medium" && (info.size < 1024 * 1024 || info.size >= 100 * 1024 * 1024)) return false;
  if (info.type === "file" && filters.size === "large" && info.size < 100 * 1024 * 1024) return false;
  const days = Number(filters.days) || 0;
  if (days && Date.now() - new Date(info.modified).getTime() > days * 86400000) return false;
  return true;
}

ipcMain.handle("fs:search", async (_event, rootPath, query, filters = {}) => {
  const root = checkedPath(rootPath);
  const needle = String(query || "").trim().toLocaleLowerCase();
  const queue = [root];
  const results = [];
  let scanned = 0;
  const skippedNames = new Set(["$recycle.bin", "system volume information"]);
  while (queue.length && scanned < MAX_SEARCH_ITEMS && results.length < MAX_SEARCH_RESULTS) {
    const directory = queue.shift();
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (scanned >= MAX_SEARCH_ITEMS || results.length >= MAX_SEARCH_RESULTS) break;
      scanned += 1;
      if (skippedNames.has(entry.name.toLocaleLowerCase())) continue;
      const itemPath = path.join(directory, entry.name);
      let info;
      try { info = await describeItem(itemPath, entry); } catch { continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(itemPath);
      if ((!needle || `${info.name} ${info.path}`.toLocaleLowerCase().includes(needle)) && matchesFilters(info, filters)) results.push(info);
    }
  }
  return { results, scanned, limited: Boolean(queue.length || results.length >= MAX_SEARCH_RESULTS) };
});

ipcMain.handle("fs:watch", async (event, directoryPath) => {
  const resolved = checkedPath(directoryPath);
  const key = `${event.sender.id}|${resolved.toLowerCase()}`;
  if (watchers.has(key) || watchers.size >= 100) return true;
  try {
    const watcher = fs.watch(resolved, { persistent: false }, (_type, name) => {
      if (!event.sender.isDestroyed()) event.sender.send("fs:changed", { path: resolved, name: name ? String(name) : "" });
    });
    watcher.on("error", () => { watcher.close(); watchers.delete(key); });
    watchers.set(key, watcher);
    event.sender.once("destroyed", () => { watcher.close(); watchers.delete(key); });
    return true;
  } catch { return false; }
});

ipcMain.handle("fs:unwatch-all", async (event) => {
  const prefix = `${event.sender.id}|`;
  for (const [key, watcher] of watchers) {
    if (key.startsWith(prefix)) { watcher.close(); watchers.delete(key); }
  }
  return true;
});

ipcMain.on("menu:show", (event, details = {}) => {
  const sender = event.sender;
  const send = (command) => sender.send("menu:command", command);
  const owner = BrowserWindow.fromWebContents(sender);
  if (details.background) {
    const menu = Menu.buildFromTemplate([
      { label: "粘贴", accelerator: "Ctrl+V", enabled: Boolean(details.canPaste), click: () => send("paste") },
      { label: "撤销上一步", accelerator: "Ctrl+Z", enabled: Boolean(details.canUndo), click: () => send("undo") },
      { type: "separator" },
      { label: "刷新", accelerator: "F5", click: () => send("refresh") },
      { label: "定位当前文件", click: () => send("locate") },
      { label: "收起其他分支", click: () => send("collapse-others") },
      { label: "全部收起", click: () => send("collapse-all") },
      { label: "回到中心", click: () => send("fit") },
      { type: "separator" },
      { label: "新建文件夹", accelerator: "Ctrl+Shift+N", click: () => send("new-folder") },
      { label: "保存当前工作区", click: () => send("save-workspace") },
      { label: "在 Windows 资源管理器中打开", click: () => send("open") },
      { type: "separator" },
      { label: "属性", click: () => send("properties") },
    ]);
    menu.popup({ window: owner || undefined });
    return;
  }
  const isFolder = details.type === "folder";
  const isRoot = Boolean(details.isRoot);
  const count = Math.max(1, Number(details.selectionCount) || 1);
  const template = [
    ...(isFolder ? [
      { label: "在图谱中打开", click: () => send("open-map") },
      { label: details.expanded ? "收起分支" : "展开分支", click: () => send("toggle-branch") },
    ] : [{ label: "打开", click: () => send("open") }]),
    { label: "在 Windows 资源管理器中显示", click: () => send("reveal") },
    { type: "separator" },
    { label: "剪切", accelerator: "Ctrl+X", enabled: !isRoot, click: () => send("cut") },
    { label: "复制", accelerator: "Ctrl+C", enabled: !isRoot, click: () => send("copy") },
    { label: "粘贴", accelerator: "Ctrl+V", enabled: isFolder && Boolean(details.canPaste), click: () => send("paste") },
    ...(isFolder ? [{ label: "新建文件夹", accelerator: "Ctrl+Shift+N", click: () => send("new-folder") }] : []),
    { type: "separator" },
    { label: `复制到…${count > 1 ? `（${count} 项）` : ""}`, enabled: !isRoot, click: () => send("copy-to") },
    { label: `移动到…${count > 1 ? `（${count} 项）` : ""}`, enabled: !isRoot, click: () => send("move-to") },
    { label: "复制完整路径", click: () => send("copy-path") },
    { type: "separator" },
    { label: "添加到收藏", click: () => send("favorite") },
    { label: details.pinned ? "取消固定位置" : "固定当前位置", click: () => send("toggle-pin") },
    { label: "定位当前文件", click: () => send("locate") },
    { type: "separator" },
    { label: "重命名", enabled: !isRoot && count === 1, accelerator: "F2", click: () => send("rename") },
    { label: `移到回收站${count > 1 ? `（${count} 项）` : ""}`, enabled: !isRoot, accelerator: "Delete", click: () => send("trash") },
    { type: "separator" },
    { label: "Windows 属性", click: () => send("properties") },
  ];
  Menu.buildFromTemplate(template).popup({ window: owner || undefined });
});
