import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../errors.js';

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b !== undefined && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && b !== undefined && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0 && parts[2] === 113) || (a === 100 && b !== undefined && b >= 64 && b <= 127) || a! >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8');
  }
  return true;
}

export interface SecureDownloaderOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  allowedHosts?: readonly string[];
  fetchImplementation?: typeof fetch;
  lookupImplementation?: typeof lookup;
}

export class SecureMediaDownloader {
  private readonly fetchImplementation: typeof fetch;
  private readonly lookupImplementation: typeof lookup;

  constructor(private readonly options: SecureDownloaderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.lookupImplementation = options.lookupImplementation ?? lookup;
  }

  async download(source: string, destination: string, signal?: AbortSignal): Promise<number> {
    let current = new URL(source);
    const redirects = this.options.maxRedirects ?? 2;
    for (let count = 0; count <= redirects; count += 1) {
      await this.validateUrl(current);
      signal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      try {
        const response = await this.fetchImplementation(current, { redirect: 'manual', signal: combinedSignal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || count === redirects) throw new ApiError(502, 'MEDIA_REDIRECT_REJECTED', 'Media download exceeded the redirect limit.');
          current = new URL(location, current);
          continue;
        }
        if (!response.ok || !response.body) throw new ApiError(502, 'MEDIA_DOWNLOAD_FAILED', `Media download failed with HTTP ${response.status}.`);
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
          throw new ApiError(502, 'INVALID_MEDIA_CONTENT_TYPE', 'Provider media response is not a supported video content type.');
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > this.options.maxBytes) throw new ApiError(413, 'MEDIA_TOO_LARGE', 'Provider media exceeds the configured byte limit.');
        let received = 0;
        const limiter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            received += chunk.length;
            callback(received > this.options.maxBytes ? new ApiError(413, 'MEDIA_TOO_LARGE', 'Provider media exceeds the configured byte limit.') : null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination, { flags: 'wx' }));
        } catch (error) {
          await rm(destination, { force: true });
          throw error;
        }
        return received;
      } finally { clearTimeout(timer); }
    }
    throw new ApiError(502, 'MEDIA_DOWNLOAD_FAILED', 'Unable to download provider media.');
  }

  private async validateUrl(url: URL): Promise<void> {
    if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError(400, 'UNSAFE_MEDIA_URL', 'Media URL must use HTTPS without embedded credentials.');
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new ApiError(400, 'UNSAFE_MEDIA_URL', 'Local media hosts are not allowed.');
    const allowed = this.options.allowedHosts?.map((host) => host.toLowerCase()).filter(Boolean) ?? [];
    if (allowed.length && !allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      throw new ApiError(400, 'MEDIA_HOST_NOT_ALLOWED', 'Media host is not in the configured allowlist.');
    }
    const addresses = await this.lookupImplementation(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new ApiError(400, 'UNSAFE_MEDIA_URL', 'Media host resolves to a private or reserved address.');
  }
}
