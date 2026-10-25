import QRCode from 'qrcode';

export async function generateQrSvg(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
  } catch (err) {
    console.error('QR generation failed:', err);
    return `<svg viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="60" fill="#eee"/><text x="10" y="35" font-family="monospace" font-size="11" fill="#333">QR Error</text></svg>`;
  }
}

