import * as QRCode from 'qrcode';

export function supportsTerminalQrRendering(
  stream: Pick<NodeJS.WriteStream, 'isTTY'> = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!stream.isTTY) {
    return false;
  }

  const term = (env.TERM || '').toLowerCase();
  return term !== '' && term !== 'dumb';
}

export async function tryRenderTerminalQrCode(
  url: string,
  renderQrCode: (
    text: string,
    options?: QRCode.QRCodeToStringOptionsTerminal
  ) => Promise<string> = (text, options) => QRCode.toString(text, options)
): Promise<string | null> {
  try {
    const output = await renderQrCode(url, {
      type: 'terminal',
      margin: 1,
      small: true,
    });
    return output.trim() ? output : null;
  } catch {
    return null;
  }
}
