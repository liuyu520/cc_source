import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { execa } from 'execa'
import { basename, extname, isAbsolute, join } from 'path'
import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  detectImageFormatFromBase64,
  type ImageDimensions,
  maybeResizeAndDownsampleImageBuffer,
} from './imageResizer.js'
import { logError } from './log.js'

// Native NSPasteboard reader. GrowthBook gate tengu_collage_kaleidoscope is
// a kill switch (default on). Falls through to osascript when off.
// The gate string is inlined at each callsite INSIDE the feature() condition
// — module-scope helpers are NOT tree-shaken (see docs/feature-gating.md).

type SupportedPlatform = 'darwin' | 'linux' | 'win32'

// Threshold in characters for when to consider text a "large paste"
export const PASTE_THRESHOLD = 800
function getClipboardCommands() {
  const platform = process.platform as SupportedPlatform

  // Platform-specific temporary file paths
  // Use CLAUDE_CODE_TMPDIR if set, otherwise fall back to platform defaults
  const baseTmpDir =
    process.env.CLAUDE_CODE_TMPDIR ||
    (platform === 'win32' ? process.env.TEMP || 'C:\\Temp' : '/tmp')
  const screenshotFilename = 'claude_cli_latest_screenshot.png'
  const tempPaths: Record<SupportedPlatform, string> = {
    darwin: join(baseTmpDir, screenshotFilename),
    linux: join(baseTmpDir, screenshotFilename),
    win32: join(baseTmpDir, screenshotFilename),
  }

  const screenshotPath = tempPaths[platform] || tempPaths.linux

  // Platform-specific clipboard commands
  const commands: Record<
    SupportedPlatform,
    {
      checkImage: string
      saveImage: string
      getPath: string
      deleteFile: string
    }
  > = {
    darwin: {
      checkImage: `osascript -e 'the clipboard as «class PNGf»'`,
      saveImage: `osascript -e 'set png_data to (the clipboard as «class PNGf»)' -e 'set fp to open for access POSIX file "${screenshotPath}" with write permission' -e 'write png_data to fp' -e 'close access fp'`,
      getPath: `osascript -e 'get POSIX path of (the clipboard as «class furl»)'`,
      deleteFile: `rm -f "${screenshotPath}"`,
    },
    linux: {
      checkImage:
        'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"',
      saveImage: `xclip -selection clipboard -t image/png -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/png > "${screenshotPath}" 2>/dev/null || xclip -selection clipboard -t image/bmp -o > "${screenshotPath}" 2>/dev/null || wl-paste --type image/bmp > "${screenshotPath}"`,
      getPath:
        'xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null',
      deleteFile: `rm -f "${screenshotPath}"`,
    },
    win32: {
      checkImage:
        'powershell -NoProfile -Command "(Get-Clipboard -Format Image) -ne $null"',
      saveImage: `powershell -NoProfile -Command "$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
      getPath: 'powershell -NoProfile -Command "Get-Clipboard"',
      deleteFile: `del /f "${screenshotPath}"`,
    },
  }

  return {
    commands: commands[platform] || commands.linux,
    screenshotPath,
  }
}

export type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
}

/**
 * Check if clipboard contains an image without retrieving it.
 */
export async function hasImageInClipboard(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  if (
    feature('NATIVE_CLIPBOARD_IMAGE') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
  ) {
    // Native NSPasteboard check (~0.03ms warm). Fall through to osascript
    // when the module/export is missing. Catch a throw too: it would surface
    // as an unhandled rejection in useClipboardImageHint's setTimeout.
    try {
      const { getNativeModule } = await import('image-processor-napi')
      const hasImage = getNativeModule()?.hasClipboardImage
      if (hasImage) {
        return hasImage()
      }
    } catch (e) {
      logError(e as Error)
    }
  }
  const result = await execFileNoThrowWithCwd('osascript', [
    '-e',
    'the clipboard as «class PNGf»',
  ])
  return result.code === 0
}

export async function getImageFromClipboard(): Promise<ImageWithDimensions | null> {
  // Fast path: native NSPasteboard reader (macOS only). Reads PNG bytes
  // directly in-process and downsamples via CoreGraphics if over the
  // dimension cap. ~5ms cold, sub-ms warm — vs. ~1.5s for the osascript
  // path below. Throws if the native module is unavailable, in which case
  // the catch block falls through to osascript. A `null` return from the
  // native call is authoritative (clipboard has no image).
  if (
    feature('NATIVE_CLIPBOARD_IMAGE') &&
    process.platform === 'darwin' &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
  ) {
    try {
      const { getNativeModule } = await import('image-processor-napi')
      const readClipboard = getNativeModule()?.readClipboardImage
      if (!readClipboard) {
        throw new Error('native clipboard reader unavailable')
      }
      const native = readClipboard(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT)
      if (!native) {
        // native 只识别 PNGf 位图,不识别 «class furl»(Finder 复制的图片文件)。
        // 这里不能直接 return null,否则 Finder Cmd+C 一个 .png 文件再 ctrl+V
        // 就会被快速路径吞掉,无法走到下面的 furl 回退。
        const filePath = await getImageFilePathFromClipboard()
        if (filePath) {
          return await readImageFileAsClipboardImage(filePath)
        }
        return null
      }
      // The native path caps dimensions but not file size. A complex
      // 2000×2000 PNG can still exceed the 3.75MB raw / 5MB base64 API
      // limit — for that edge case, run through the same size-cap that
      // the osascript path uses (degrades to JPEG if needed). Cheap if
      // already under: just a sharp metadata read.
      const buffer: Buffer = native.png
      if (buffer.length > IMAGE_TARGET_RAW_SIZE) {
        const resized = await maybeResizeAndDownsampleImageBuffer(
          buffer,
          buffer.length,
          'png',
        )
        return {
          base64: resized.buffer.toString('base64'),
          mediaType: `image/${resized.mediaType}`,
          // resized.dimensions sees the already-downsampled buffer; native knows the true originals.
          dimensions: {
            originalWidth: native.originalWidth,
            originalHeight: native.originalHeight,
            displayWidth: resized.dimensions?.displayWidth ?? native.width,
            displayHeight: resized.dimensions?.displayHeight ?? native.height,
          },
        }
      }
      return {
        base64: buffer.toString('base64'),
        mediaType: 'image/png',
        dimensions: {
          originalWidth: native.originalWidth,
          originalHeight: native.originalHeight,
          displayWidth: native.width,
          displayHeight: native.height,
        },
      }
    } catch (e) {
      logError(e as Error)
      // Fall through to osascript fallback.
    }
  }

  const { commands, screenshotPath } = getClipboardCommands()
  try {
    // Check if clipboard has image
    const checkResult = await execa(commands.checkImage, {
      shell: true,
      reject: false,
    })
    if (checkResult.exitCode !== 0) {
      // 回退:剪贴板里没有 PNGf 位图数据,但可能是 Finder/QQ/微信复制的"图片文件"
      // (类型是 «class furl» / public.file-url)。尝试拿到文件路径,如果后缀是
      // 图片就直接读文件字节当图片处理。这样 ctrl+V 也能粘贴 Finder 复制的图片。
      const filePath = await getImageFilePathFromClipboard()
      if (filePath) {
        return await readImageFileAsClipboardImage(filePath)
      }
      return null
    }

    // Save the image
    const saveResult = await execa(commands.saveImage, {
      shell: true,
      reject: false,
    })
    if (saveResult.exitCode !== 0) {
      return null
    }

    // Read the image and convert to base64
    let imageBuffer = getFsImplementation().readFileBytesSync(screenshotPath)

    // BMP is not supported by the API — convert to PNG via Sharp.
    // This handles WSL2 where Windows copies images as BMP by default.
    if (
      imageBuffer.length >= 2 &&
      imageBuffer[0] === 0x42 &&
      imageBuffer[1] === 0x4d
    ) {
      const sharp = await getImageProcessor()
      imageBuffer = await sharp(imageBuffer).png().toBuffer()
    }

    // Resize if needed to stay under 5MB API limit
    // 真实环境里 sharp 包没装(restoration build),resizer 内部任何 sharp 调用都会抛错;
    // 一旦图片宽或高 > 2000,fallback 也会以 ImageResizeError 抛出。这里降级:只要原图
    // base64 在 5MB API 限制以内,就直接用原 buffer,不要因为客户端的 token 优化阈值
    // 把整张能正常上传的图丢成 null。返回 null 会让用户看到"剪贴板没图片"的误导提示。
    const base64Image = await resizeOrFallback(imageBuffer)
    if (!base64Image) {
      return null
    }

    // Detect format from magic bytes
    const mediaType = detectImageFormatFromBase64(base64Image.base64)

    // Cleanup (fire-and-forget, don't await)
    void execa(commands.deleteFile, { shell: true, reject: false })

    return {
      base64: base64Image.base64,
      mediaType,
      dimensions: base64Image.dimensions,
    }
  } catch (e) {
    // 之前是静默 catch,任何异常(resize 失败/读文件失败/sharp 缺失)都被吞成"剪贴板没图片"
    // 的误导提示。改成 logError,以后再排查时能在日志里看到真正的异常。
    logError(e as Error)
    return null
  }
}

/**
 * 尝试通过 maybeResizeAndDownsampleImageBuffer 做尺寸/大小压缩;失败时降级:
 * 如果原图 base64 仍在 API 5MB 限制内,直接返回原 buffer。Anthropic API 接受
 * 大尺寸图片,2000x2000 是客户端为了省 token 自加的优化阈值,不应该作为硬阻断。
 */
async function resizeOrFallback(
  imageBuffer: Buffer,
): Promise<{ base64: string; dimensions?: ImageDimensions } | null> {
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      imageBuffer.length,
      'png',
    )
    return {
      base64: resized.buffer.toString('base64'),
      dimensions: resized.dimensions,
    }
  } catch (e) {
    logError(e as Error)
    // base64 实际长度 ≈ ceil(raw * 4 / 3),用 5MB 作为 API 上限粗略校验
    const base64Size = Math.ceil((imageBuffer.length * 4) / 3)
    if (base64Size <= 5 * 1024 * 1024) {
      return { base64: imageBuffer.toString('base64') }
    }
    return null
  }
}

export async function getImagePathFromClipboard(): Promise<string | null> {
  const { commands } = getClipboardCommands()

  try {
    // Try to get text from clipboard
    const result = await execa(commands.getPath, {
      shell: true,
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    return result.stdout.trim()
  } catch (e) {
    logError(e as Error)
    return null
  }
}

/**
 * 从剪贴板取出"被复制的图片文件路径"。仅 darwin/linux 实现,跨所有路径复用 osascript
 * 的 furl 命令(getClipboardCommands().getPath)。和 getImagePathFromClipboard 的区别:
 * 这个函数会校验路径是图片文件后缀,目的是给 ctrl+V 粘贴文件场景使用,而不是给"路径文本
 * 输入"用。getImagePathFromClipboard 会在 Linux/Windows 上把任意文本当路径返回,这里不复用。
 */
async function getImageFilePathFromClipboard(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    // 非 darwin 暂不支持文件 URL 路径回退(linux 的 xclip text/plain 容易和普通文本混淆)
    return null
  }
  try {
    const result = await execa(
      `osascript -e 'get POSIX path of (the clipboard as «class furl»)'`,
      { shell: true, reject: false },
    )
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    const path = result.stdout.trim()
    if (!IMAGE_EXTENSION_REGEX.test(path)) {
      return null
    }
    return path
  } catch {
    return null
  }
}

/**
 * 把磁盘上的图片文件读成 ImageWithDimensions,复用 maybeResizeAndDownsampleImageBuffer
 * 与 PNGf 路径完全相同的尺寸/大小处理,保证下游 onImagePaste 行为一致。
 */
async function readImageFileAsClipboardImage(
  filePath: string,
): Promise<ImageWithDimensions | null> {
  try {
    const buffer = getFsImplementation().readFileBytesSync(filePath)
    const ext = extname(filePath).toLowerCase().replace('.', '')
    const inputFormat: 'png' | 'jpeg' | 'gif' | 'webp' =
      ext === 'jpg' || ext === 'jpeg'
        ? 'jpeg'
        : ext === 'gif'
          ? 'gif'
          : ext === 'webp'
            ? 'webp'
            : 'png'
    // 同样的降级:resize 失败时只要 base64 在 5MB 内就用原 buffer。
    // 注:inputFormat 暂未参与降级路径(降级直接走原 buffer 字节),保留参数是为了
    // 给 maybeResizeAndDownsampleImageBuffer 一个 hint。
    void inputFormat
    const fallback = await resizeOrFallback(buffer)
    if (!fallback) return null
    const mediaType = detectImageFormatFromBase64(fallback.base64)
    return {
      base64: fallback.base64,
      mediaType,
      dimensions: fallback.dimensions,
    }
  } catch (e) {
    logError(e as Error)
    return null
  }
}

/**
 * Regex pattern to match supported image file extensions. Kept in sync with
 * MIME_BY_EXT in BriefTool/upload.ts — attachments.ts uses this to set isImage
 * on the wire, and remote viewers fetch /preview iff isImage is true. An ext
 * here but not in MIME_BY_EXT (e.g. bmp) uploads as octet-stream and has no
 * /preview variant → broken thumbnail.
 */
export const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i

/**
 * Remove outer single or double quotes from a string
 * @param text Text to clean
 * @returns Text without outer quotes
 */
function removeOuterQuotes(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Remove shell escape backslashes from a path (for macOS/Linux/WSL)
 * On Windows systems, this function returns the path unchanged
 * @param path Path that might contain shell-escaped characters
 * @returns Path with escape backslashes removed (on macOS/Linux/WSL only)
 */
function stripBackslashEscapes(path: string): string {
  const platform = process.platform as SupportedPlatform

  // On Windows, don't remove backslashes as they're part of the path
  if (platform === 'win32') {
    return path
  }

  // On macOS/Linux/WSL, handle shell-escaped paths
  // Double-backslashes (\\) represent actual backslashes in the filename
  // Single backslashes followed by special chars are shell escapes

  // First, temporarily replace double backslashes with a placeholder
  // Use random salt to prevent injection attacks where path contains literal placeholder
  const salt = randomBytes(8).toString('hex')
  const placeholder = `__DOUBLE_BACKSLASH_${salt}__`
  const withPlaceholder = path.replace(/\\\\/g, placeholder)

  // Remove single backslashes that are shell escapes
  // This handles cases like "name\ \(15\).png" -> "name (15).png"
  const withoutEscapes = withPlaceholder.replace(/\\(.)/g, '$1')

  // Replace placeholders back to single backslashes
  return withoutEscapes.replace(new RegExp(placeholder, 'g'), '\\')
}

/**
 * Check if a given text represents an image file path
 * @param text Text to check
 * @returns Boolean indicating if text is an image path
 */
export function isImageFilePath(text: string): boolean {
  const cleaned = removeOuterQuotes(text.trim())
  const unescaped = stripBackslashEscapes(cleaned)
  return IMAGE_EXTENSION_REGEX.test(unescaped)
}

/**
 * Clean and normalize a text string that might be an image file path
 * @param text Text to process
 * @returns Cleaned text with quotes removed, whitespace trimmed, and shell escapes removed, or null if not an image path
 */
export function asImageFilePath(text: string): string | null {
  const cleaned = removeOuterQuotes(text.trim())
  const unescaped = stripBackslashEscapes(cleaned)

  if (IMAGE_EXTENSION_REGEX.test(unescaped)) {
    return unescaped
  }

  return null
}

/**
 * Try to find and read an image file, falling back to clipboard search
 * @param text Pasted text that might be an image filename or path
 * @returns Object containing the image path and base64 data, or null if not found
 */
export async function tryReadImageFromPath(
  text: string,
): Promise<(ImageWithDimensions & { path: string }) | null> {
  // Strip terminal added spaces or quotes to dragged in paths
  const cleanedPath = asImageFilePath(text)

  if (!cleanedPath) {
    return null
  }

  const imagePath = cleanedPath
  let imageBuffer

  try {
    if (isAbsolute(imagePath)) {
      imageBuffer = getFsImplementation().readFileBytesSync(imagePath)
    } else {
      // VSCode Terminal just grabs the text content which is the filename
      // instead of getting the full path of the file pasted with cmd-v. So
      // we check if it matches the filename of the image in the clipboard.
      const clipboardPath = await getImagePathFromClipboard()
      if (clipboardPath && imagePath === basename(clipboardPath)) {
        imageBuffer = getFsImplementation().readFileBytesSync(clipboardPath)
      }
    }
  } catch (e) {
    logError(e as Error)
    return null
  }
  if (!imageBuffer) {
    return null
  }
  if (imageBuffer.length === 0) {
    logForDebugging(`Image file is empty: ${imagePath}`, { level: 'warn' })
    return null
  }

  // BMP is not supported by the API — convert to PNG via Sharp.
  if (
    imageBuffer.length >= 2 &&
    imageBuffer[0] === 0x42 &&
    imageBuffer[1] === 0x4d
  ) {
    const sharp = await getImageProcessor()
    imageBuffer = await sharp(imageBuffer).png().toBuffer()
  }

  // Resize if needed to stay under 5MB API limit
  // Extract extension from path for format hint
  const ext = extname(imagePath).slice(1).toLowerCase() || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    imageBuffer.length,
    ext,
  )
  const base64Image = resized.buffer.toString('base64')

  // Detect format from the actual file contents using magic bytes
  const mediaType = detectImageFormatFromBase64(base64Image)
  return {
    path: imagePath,
    base64: base64Image,
    mediaType,
    dimensions: resized.dimensions,
  }
}
