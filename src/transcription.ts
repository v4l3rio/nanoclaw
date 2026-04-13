import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data/models/ggml-base.bin');
const WHISPER_LANG = process.env.WHISPER_LANG || 'it';

/**
 * Transcribe an audio buffer using local whisper.cpp.
 * Converts input to 16kHz mono WAV via ffmpeg, then runs whisper-cli.
 * Returns the transcribed text or null on failure.
 */
export async function transcribeAudio(audio: Buffer): Promise<string | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-voice-'));
  const inputPath = path.join(tmpDir, 'input.ogg');
  const wavPath = path.join(tmpDir, 'input.wav');

  try {
    fs.writeFileSync(inputPath, audio);

    // Convert to 16kHz mono WAV (whisper.cpp requirement)
    await execPromise('ffmpeg', [
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      '-y',
      wavPath,
    ]);

    // Run whisper-cli
    const output = await execPromise(WHISPER_BIN, [
      '-m',
      WHISPER_MODEL,
      '-f',
      wavPath,
      '-l',
      WHISPER_LANG,
      '--no-timestamps',
      '-nt',
    ]);

    const text = output.trim();
    if (!text) return null;

    logger.info({ chars: text.length }, 'Transcribed voice message');
    return text;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function execPromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
