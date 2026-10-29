const DELTA = 0x9e3779b9 >>> 0
const FALLBACK_KEY: [number, number, number, number] = [1888420705, 2576816180, 2347232058, 874813317]
const FALLBACK_VER = '4.0.0'
const FALLBACK_IDENTIFIER = 'ECdITeCs'

let cachedKey: [number, number, number, number] | null = null
let cachedVersion = ''
let cachedIdentifier = ''
let refreshPromise: Promise<void> | null = null

function extractFromAppJS(js: string): {
  key: [number, number, number, number] | null
  identifier: string
  version: string
} {
  let key: [number, number, number, number] | null = null
  let identifier = ''
  let version = ''

  const keyMatch = js.match(
    /var\s+\w+\s*=\s*\[(\d+),\s*"([A-Za-z0-9]+)",\s*(\d+),\s*(\d+),\s*(\d+)\]/
  )
  if (keyMatch) {
    const nums = [keyMatch[1], keyMatch[3], keyMatch[4], keyMatch[5]].map(Number)
    key = [nums[2], nums[0], nums[3], nums[1]]
    identifier = keyMatch[2]
  }

  const verMatch = js.match(/FWCIM_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/)
  if (verMatch) {
    version = verMatch[1]
  }

  return { key, identifier, version }
}

export async function refreshAppJSConfig(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>
): Promise<void> {
  if (cachedKey) return
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    if (cachedKey) return
    try {
      const resp = await fetchFn('https://us-east-1.signin.aws/assets/js/app.js', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          Accept: '*/*',
          Referer: 'https://us-east-1.signin.aws/'
        }
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const js = await resp.text()
      if (js) {
        const result = extractFromAppJS(js)
        if (result.key) cachedKey = result.key
        if (result.identifier) cachedIdentifier = result.identifier
        if (result.version) cachedVersion = result.version
      }
    } catch (err) {
      console.log('[xxtea] 下载 app.js 失败:', err)
    }

    // 没拿到密钥时不缓存 fallback：getActiveKey 等读取函数本身会回落到 fallback，
    // 而 cachedKey 保持为空，下次调用会重新尝试下载，不会因一次网络失败永久锁死
    if (!cachedKey) console.log('[xxtea] 本次使用 fallback 密钥，下次将重试下载')
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export function getTESVersion(): string {
  return cachedVersion || FALLBACK_VER
}

export function getIdentifier(): string {
  return cachedIdentifier || FALLBACK_IDENTIFIER
}

export function getActiveKey(): [number, number, number, number] {
  return cachedKey
    ? ([...cachedKey] as [number, number, number, number])
    : ([...FALLBACK_KEY] as [number, number, number, number])
}

function xxteaEncryptCore(plaintext: string, key: [number, number, number, number]): Buffer {
  if (!plaintext.length) return Buffer.alloc(0)

  const n = Math.ceil(plaintext.length / 4)
  const v = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0
    if (4 * i < plaintext.length) b0 = plaintext.charCodeAt(4 * i)
    if (4 * i + 1 < plaintext.length) b1 = plaintext.charCodeAt(4 * i + 1)
    if (4 * i + 2 < plaintext.length) b2 = plaintext.charCodeAt(4 * i + 2)
    if (4 * i + 3 < plaintext.length) b3 = plaintext.charCodeAt(4 * i + 3)
    v[i] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
  }

  const rounds = 6 + Math.floor(52 / n)
  let z = v[n - 1]
  let total = 0

  for (let r = 0; r < rounds; r++) {
    total = (total + DELTA) >>> 0
    const e = (total >>> 2) & 3
    for (let p = 0; p < n; p++) {
      const y = v[(p + 1) % n]
      const part1 = ((z >>> 5) ^ (y << 2)) >>> 0
      const part2 = ((y >>> 3) ^ (z << 4)) >>> 0
      const group1 = (part1 + part2) >>> 0
      const part3 = (total ^ y) >>> 0
      const part4 = (key[(p & 3) ^ e] ^ z) >>> 0
      const group2 = (part3 + part4) >>> 0
      const mx = (group1 ^ group2) >>> 0
      v[p] = (v[p] + mx) >>> 0
      z = v[p]
    }
  }

  const result = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    result[4 * i] = v[i] & 0xff
    result[4 * i + 1] = (v[i] >>> 8) & 0xff
    result[4 * i + 2] = (v[i] >>> 16) & 0xff
    result[4 * i + 3] = (v[i] >>> 24) & 0xff
  }
  return result
}

/** 加密指纹 JSON: JSON -> CRC32前缀 -> XXTEA加密 -> base64 -> identifier:结果 */
export function encryptFingerprint(jsonStr: string): string {
  const crc = crc32(jsonStr)
  const crcHex = crc.toString(16).toUpperCase().padStart(8, '0')
  const plaintext = crcHex + '#' + jsonStr

  const key = getActiveKey()
  const encrypted = xxteaEncryptCore(plaintext, key)
  const encoded = encrypted.toString('base64')
  return getIdentifier() + ':' + encoded
}

/** CRC32 (IEEE) */
function crc32(str: string): number {
  const table = crc32Table()
  let crc = 0xffffffff >>> 0
  for (let i = 0; i < str.length; i++) {
    crc = ((crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xff]) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

let _crc32Table: Uint32Array | null = null
function crc32Table(): Uint32Array {
  if (_crc32Table) return _crc32Table
  _crc32Table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i >>> 0
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    }
    _crc32Table[i] = c
  }
  return _crc32Table
}
