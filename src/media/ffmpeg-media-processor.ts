import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { ApiError } from '../errors.js';

interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }
interface ProbeResult { format?: { duration?: string }; streams?: ProbeStream[] }

async function command(executable: string, args: string[], timeoutMs = 600_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ApiError(504, 'MEDIA_PROCESS_TIMEOUT', `${executable} exceeded its time limit.`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(new ApiError(500, 'MEDIA_TOOL_UNAVAILABLE', `${executable} is unavailable: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new ApiError(502, 'MEDIA_PROCESS_FAILED', `${executable} failed with exit code ${code}: ${stderr.slice(-1_000)}`));
    });
  });
}

export class FfmpegMediaProcessor {
  async probe(path: string): Promise<ProbeResult> {
    const output = await command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
    const result = JSON.parse(output) as ProbeResult;
    if (!result.streams?.some((stream) => stream.codec_type === 'video')) throw new ApiError(502, 'INVALID_VIDEO_MEDIA', 'Downloaded media has no video stream.');
    return result;
  }

  async normalize(input: string, output: string, resolution: string, segmentDuration: number): Promise<void> {
    const probe = await this.probe(input);
    const hasAudio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
    const [width, height] = resolution === '1080p' ? [1920, 1080] : [1280, 720];
    const videoArgs = ['-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
    const args = hasAudio
      ? ['-y', '-i', input, ...videoArgs, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(segmentDuration), output]
      : ['-y', '-i', input, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0', ...videoArgs, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(segmentDuration), '-shortest', output];
    await command('ffmpeg', args);
  }

  async concatenate(inputs: string[], manifest: string, concatenated: string): Promise<void> {
    const content = inputs.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join('\n');
    await writeFile(manifest, content, 'utf8');
    await command('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-c', 'copy', concatenated]);
  }

  async finalize(input: string, output: string, targetDuration: number): Promise<void> {
    await command('ffmpeg', ['-y', '-i', input, '-t', String(targetDuration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', output]);
    const probe = await this.probe(output);
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || Math.abs(duration - targetDuration) > 0.25) throw new ApiError(502, 'INVALID_FINAL_DURATION', 'Rendered video duration is outside the allowed tolerance.');
  }
}
