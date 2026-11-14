// encoding.js - detection and conversion of the encodings Notepad++ offers.
// The editor always holds UTF-8; files are decoded on open and encoded on save.

export const ENCODINGS = {
  'ansi': { label: 'ANSI', status: 'ANSI' },
  'utf-8': { label: 'UTF-8', status: 'UTF-8' },
  'utf-8-bom': { label: 'UTF-8-BOM', status: 'UTF-8-BOM' },
  'utf-16be': { label: 'UTF-16 BE BOM', status: 'UTF-16 BE BOM' },
  'utf-16le': { label: 'UTF-16 LE BOM', status: 'UTF-16 LE BOM' },
};

let cp1252Reverse = null;
function cp1252Table() {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map();
    const dec = new TextDecoder('windows-1252');
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const s = dec.decode(bytes);
    for (let i = 0; i < 256; i++) cp1252Reverse.set(s.charCodeAt(i), i);
  }
  return cp1252Reverse;
}

// Returns { text, encoding }
export function decodeBytes(bytes, forced) {
  let enc = forced;
  if (!enc) {
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) enc = 'utf-8-bom';
    else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) enc = 'utf-16le';
    else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) enc = 'utf-16be';
    else {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        enc = 'utf-8';
      } catch (_) {
        enc = 'ansi';
      }
    }
  }
  let text;
  switch (enc) {
    case 'utf-8-bom': {
      const skip = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
      text = new TextDecoder('utf-8').decode(bytes.subarray(skip));
      break;
    }
    case 'utf-16le': {
      const skip = bytes[0] === 0xFF && bytes[1] === 0xFE ? 2 : 0;
      text = new TextDecoder('utf-16le').decode(bytes.subarray(skip));
      break;
    }
    case 'utf-16be': {
      const skip = bytes[0] === 0xFE && bytes[1] === 0xFF ? 2 : 0;
      text = new TextDecoder('utf-16be').decode(bytes.subarray(skip));
      break;
    }
    case 'ansi':
      text = new TextDecoder('windows-1252').decode(bytes);
      break;
    default:
      text = new TextDecoder('utf-8').decode(bytes);
  }
  return { text, encoding: enc };
}

export function encodeText(text, enc) {
  switch (enc) {
    case 'utf-8-bom': {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(body.length + 3);
      out.set([0xEF, 0xBB, 0xBF]);
      out.set(body, 3);
      return out;
    }
    case 'utf-16le':
    case 'utf-16be': {
      const le = enc === 'utf-16le';
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = le ? 0xFF : 0xFE;
      out[1] = le ? 0xFE : 0xFF;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = le ? c & 0xFF : c >> 8;
        out[3 + i * 2] = le ? c >> 8 : c & 0xFF;
      }
      return out;
    }
    case 'ansi': {
      const t = cp1252Table();
      const out = new Uint8Array(text.length);
      let n = 0;
      for (const ch of text) {
        const b = t.get(ch.charCodeAt(0));
        out[n++] = b === undefined || ch.length > 1 ? 0x3F : b;
      }
      return out.subarray(0, n);
    }
    default:
      return new TextEncoder().encode(text);
  }
}

export function detectEol(text) {
  const i = text.search(/\r\n|\n|\r/);
  if (i < 0) return null;
  if (text[i] === '\r') return text[i + 1] === '\n' ? 'crlf' : 'cr';
  return 'lf';
}
