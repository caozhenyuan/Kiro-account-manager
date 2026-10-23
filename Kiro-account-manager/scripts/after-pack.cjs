// electron-builder afterPack：删除 koffi 中与目标平台无关的原生库（每个约 1.5MB，共 18 个平台）。
// 不能用平台级 `files` 实现：electron-builder 的平台级 files 会整体替换顶层 files，
// 顶层的排除规则随之失效。
const fs = require('fs')
const path = require('path')
const { Arch } = require('builder-util')

// koffi 目录名用 Node 的 process.platform / process.arch 命名
const KOFFI_ARCH = { ia32: 'ia32', x64: 'x64', armv7l: 'armhf', arm64: 'arm64' }

function keepDirs(platform, arch) {
  if (arch === 'universal') return (name) => name.startsWith('darwin_')
  const a = KOFFI_ARCH[arch] || arch
  if (platform === 'linux') {
    // glibc / musl 在运行时才判定，两者都保留
    return (name) => name === `linux_${a}` || name === `musl_${a}`
  }
  return (name) => name === `${platform}_${a}`
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = Arch[context.arch]
  const resourcesDir =
    platform === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const koffiDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'koffi', 'build', 'koffi')
  if (!fs.existsSync(koffiDir)) {
    console.log(`  • afterPack: koffi native dir not found, skip (${koffiDir})`)
    return
  }
  const keep = keepDirs(platform, arch)
  const kept = []
  const removed = []
  for (const name of fs.readdirSync(koffiDir)) {
    if (keep(name)) {
      kept.push(name)
    } else {
      fs.rmSync(path.join(koffiDir, name), { recursive: true, force: true })
      removed.push(name)
    }
  }
  if (kept.length === 0) {
    throw new Error(`afterPack: no koffi native library left for ${platform}-${arch}`)
  }
  console.log(`  • afterPack: koffi kept [${kept.join(', ')}], removed ${removed.length} other platforms`)
}
