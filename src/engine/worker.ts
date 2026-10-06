// EngineWorker 源码（以 Blob classic worker 形式创建）
//
// 为什么不直接用 vite 打包 worker（new Worker(new URL('./worker.ts', ...))）：
// 实测该社区 pikafish.js 构建在 vite dev 的 module worker 与 build 的 iife worker 中
// 均静默失效（引擎初始化无输出），仅在裸 classic worker 中工作正常。
// 因此把 worker 代码做成自包含字符串，由主线程用 Blob + classic worker 创建，
// dev/build 行为完全一致（探测过程见 DEVLOG）。
//
// 协议（与 AnalysisEngine.kt 的 pendingFen/stop 模式同构）：
// 主线程 → worker：
//   { type: 'init', engineDir }             引擎目录绝对 URL（结尾带 /）
//   { type: 'uci', cmd }                    setoption / ucinewgame 直通
//   { type: 'go', id, fen, moves, goCmd, excluded }  搜索请求
//   { type: 'stopSearch', id }              中止指定搜索（闪电出着）
// worker → 主线程：
//   { type: 'ready', engineId, engineName } UCI 握手完成
//   { type: 'info', id, text }              info 原始行（主线程解析）
//   { type: 'bestmove', id, text }          bestmove 原始行
//   { type: 'log', text }                   调试日志

export const workerSource = `
'use strict'
var engine = null
var ready = false
var engineId = ''
var engineName = ''
var activeSearchId = null
var pendingGo = null

function post(m) { self.postMessage(m) }
self.onerror = function (e) { post({ type: 'error', text: 'worker error: ' + (e && e.message ? e.message : e) }) }
self.onunhandledrejection = function (e) { post({ type: 'error', text: 'worker unhandled: ' + (e && e.reason ? e.reason : e) }) }

// UCI 命令串行队列：sendCommand 同步驱动引擎单轮 UCI 循环，
// 若在 stdout 回调（onLine）里直接 sendCommand 会重入 wasm_uci_execute 导致引擎挂起。
// 队列保证命令逐条执行、绝不重入。
var cmdQueue = []
var draining = false
function drainQueue() {
  if (draining || cmdQueue.length === 0 || !engine) return
  draining = true
  while (cmdQueue.length > 0 && engine) {
    engine.sendCommand(cmdQueue.shift())
  }
  draining = false
}
function sendUci(cmd) {
  cmdQueue.push(cmd)
  setTimeout(drainQueue, 0)
}

function startSearch(go) {
  activeSearchId = go.id
  var movesPart = go.moves.length > 0 ? ' moves ' + go.moves.join(' ') : ''
  sendUci('position fen ' + go.fen + movesPart)
  var excludedPart = go.excluded.length > 0 ? ' searchmoves ' + go.excluded.join(' ') : ''
  sendUci('go ' + go.goCmd + excludedPart)
}

function requestSearch(go) {
  if (activeSearchId != null) {
    // 已有搜索在跑：排队，stop 旧搜索（旧 bestmove 回来后自动启动新搜索）
    pendingGo = go
    sendUci('stop')
  } else {
    pendingGo = null
    startSearch(go)
  }
}

function onLine(text) {
  text = (text || '').trim()
  if (!text) return
  if (!ready) {
    if (text === 'uciok') {
      sendUci('setoption name Hash value 64')
      sendUci('setoption name Threads value 1')
      sendUci('setoption name MultiPV value 1')
      sendUci('setoption name UCI_ShowWDL value true')
      sendUci('ucinewgame')
      sendUci('isready')
      return
    }
    if (text.indexOf('id name ') === 0) { engineName = text.slice(8); return }
    if (text.indexOf('id author ') === 0) { engineId = text.slice(10); return }
    if (text === 'readyok') {
      ready = true
      post({ type: 'ready', engineId: engineId, engineName: engineName })
      return
    }
    return
  }
  if (text.indexOf('info ') === 0 && activeSearchId != null) {
    post({ type: 'info', id: activeSearchId, text: text })
    return
  }
  if (text.indexOf('bestmove ') === 0) {
    var finishedId = activeSearchId
    activeSearchId = null
    if (finishedId != null) post({ type: 'bestmove', id: finishedId, text: text })
    if (pendingGo) {
      var next = pendingGo
      pendingGo = null
      startSearch(next)
    }
    return
  }
  post({ type: 'log', text: text })
}

self.onmessage = async function (e) {
  var m = e.data
  if (m.type === 'init') {
    try {
      post({ type: 'log', text: '开始加载引擎脚本…' })
      var resp = await fetch(m.engineDir + 'pikafish.js', { cache: 'no-cache' })
      var code = await resp.text()
      var moduleObj = { exports: {} }
      // emscripten 用 typeof importScripts 检测 worker 环境；以参数注入假函数
      // （该构建仅做 typeof 检测，从不实际调用）
      new Function('module', 'exports', 'importScripts', code)(
        moduleObj, moduleObj.exports,
        function () { throw new Error('importScripts unavailable') },
      )
      var factory = moduleObj.exports.pikafish || moduleObj.exports.Pikafish ||
        moduleObj.exports.default || moduleObj.exports
      post({ type: 'log', text: '脚本装载完成，创建引擎实例…' })
      var mod = await factory({
        locateFile: function (f) { return m.engineDir + f },
        mainScriptUrlOrBlob: m.engineDir + 'pikafish.js',
        onReceiveStdout: onLine,
        onReceiveStderr: function (l) { post({ type: 'log', text: '[stderr] ' + l }) },
        onExit: function (c) { post({ type: 'log', text: '引擎退出 code=' + c }) },
      })
      engine = mod
      post({ type: 'log', text: '引擎实例创建完成，发 uci…' })
      engine.sendCommand('uci')
    } catch (err) {
      post({ type: 'error', text: 'engine init failed: ' + err })
    }
    return
  }
  if (m.type === 'uci') { sendUci(m.cmd); return }
  if (m.type === 'go') { requestSearch(m); return }
  if (m.type === 'stopSearch') { if (activeSearchId === m.id) sendUci('stop') }
}
`
