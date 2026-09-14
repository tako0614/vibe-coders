import { createConnection, type Socket } from 'node:net';
import { createCipheriv } from 'node:crypto';
import { deflateSync } from 'node:zlib';

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, body: Buffer) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, body])));
  return Buffer.concat([length, name, body, crc]);
}
function encodePng(width: number, height: number, pixels: Buffer) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4,
        target = y * (width * 3 + 1) + 1 + x * 3;
      rows[target] = pixels[source + 2];
      rows[target + 1] = pixels[source + 1];
      rows[target + 2] = pixels[source];
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal RFB 3.3/3.7/3.8 client: raw frames, shared sessions and standard keys.
 * Use an SSH loopback tunnel for remote desktops; credentials never travel through chat. */
export class RfbClient {
  readonly socket: Socket;
  private buffered = Buffer.alloc(0);
  private waiter?: () => void;
  private failure?: Error;
  private deadline?: ReturnType<typeof setTimeout>;
  width = 0;
  height = 0;
  constructor(
    host: string,
    port: number,
    readonly guard: () => void = () => {},
  ) {
    this.socket = createConnection({ host, port });
    this.socket.on('data', (chunk: Buffer) => {
      if (this.buffered.length + chunk.length > 64 * 1024 * 1024) {
        this.socket.destroy(new Error('RFB input exceeds bound.'));
        return;
      }
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.waiter?.();
    });
    const failed = () => {
      this.failure = new Error('VNC connection ended or timed out.');
      this.waiter?.();
    };
    this.socket.on('error', failed);
    this.socket.on('close', failed);
    this.begin();
  }
  get closed() {
    return this.socket.destroyed || !!this.failure;
  }
  begin() {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.socket.destroy(new Error('VNC timeout.')), 15000);
  }
  idle() {
    clearTimeout(this.deadline);
  }
  async read(length: number): Promise<Buffer> {
    if (length < 0 || length > 64 * 1024 * 1024) throw new Error('RFB field exceeds bound.');
    while (this.buffered.length < length) {
      this.guard();
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
    this.guard();
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }
  write(data: Uint8Array) {
    this.guard();
    this.socket.write(data);
  }
  async connect(password?: string) {
    const version = (await this.read(12)).toString();
    if (!/^RFB 003\.00[378]\n$/.test(version)) throw new Error('Unsupported RFB version.');
    const minor = Number(version.slice(8, 11));
    this.write(Buffer.from(version));
    let security: number;
    if (minor === 3) security = (await this.read(4)).readUInt32BE();
    else {
      const count = (await this.read(1))[0];
      if (!count) throw new Error('VNC server rejected connection.');
      const types = await this.read(count);
      security = password && types.includes(2) ? 2 : types.includes(1) ? 1 : 0;
      if (!security)
        throw new Error(
          'Configure VNC password authentication or an authenticated loopback tunnel.',
        );
      this.write(Buffer.from([security]));
    }
    if (security === 2) {
      if (!password) throw new Error('VNC password is required.');
      const key = Buffer.alloc(8);
      Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
      for (let i = 0; i < 8; i++) {
        let reversed = 0;
        for (let bit = 0; bit < 8; bit++) reversed |= ((key[i] >> bit) & 1) << (7 - bit);
        key[i] = reversed;
      }
      const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
      cipher.setAutoPadding(false);
      this.write(Buffer.concat([cipher.update(await this.read(16)), cipher.final()]));
    } else if (security !== 1) throw new Error('Unsupported VNC authentication.');
    if (security === 2 || minor >= 8)
      if ((await this.read(4)).readUInt32BE() !== 0)
        throw new Error('VNC authentication rejected.');
    this.write(Buffer.from([1])); // shared desktop, never disconnect the human viewer
    const init = await this.read(24);
    this.width = init.readUInt16BE();
    this.height = init.readUInt16BE(2);
    if (!this.width || !this.height || this.width * this.height > 16000000)
      throw new Error('VNC display is too large.');
    const nameLength = init.readUInt32BE(20);
    if (nameLength > 10000) throw new Error('Invalid VNC name.');
    await this.read(nameLength);
    // 32 bits, 24-bit true color, little-endian BGRx.
    const format = Buffer.alloc(20);
    format[4] = 32;
    format[5] = 24;
    format[7] = 1;
    format.writeUInt16BE(255, 8);
    format.writeUInt16BE(255, 10);
    format.writeUInt16BE(255, 12);
    format[14] = 16;
    format[15] = 8;
    this.write(format);
    this.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
    return this;
  }
  async screenshot() {
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(this.width, 6);
    request.writeUInt16BE(this.height, 8);
    this.write(request);
    const pixels = Buffer.alloc(this.width * this.height * 4);
    for (let messages = 0; messages < 1000; messages++) {
      const type = (await this.read(1))[0];
      if (type === 2) continue; // bell
      if (type === 3) {
        const header = await this.read(7);
        const size = header.readUInt32BE(3);
        if (size > 1024 * 1024) throw new Error('VNC clipboard exceeds bound.');
        await this.read(size);
        continue;
      }
      if (type !== 0) throw new Error('Unsupported VNC server message.');
      const count = (await this.read(3)).readUInt16BE(1);
      if (!count) continue;
      if (count > 10000) throw new Error('Too many VNC rectangles.');
      for (let i = 0; i < count; i++) {
        const rect = await this.read(12),
          x = rect.readUInt16BE(),
          y = rect.readUInt16BE(2),
          width = rect.readUInt16BE(4),
          height = rect.readUInt16BE(6);
        if (rect.readInt32BE(8) !== 0 || x + width > this.width || y + height > this.height)
          throw new Error('Invalid raw VNC rectangle.');
        const raw = await this.read(width * height * 4);
        for (let row = 0; row < height; row++)
          raw.copy(
            pixels,
            ((y + row) * this.width + x) * 4,
            row * width * 4,
            (row + 1) * width * 4,
          );
      }
      return encodePng(this.width, this.height, pixels);
    }
    throw new Error('VNC did not provide a frame.');
  }
  pointer(x: number, y: number, buttons = 0) {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.width ||
      y >= this.height
    )
      throw new Error('Pointer is outside the VNC display.');
    const data = Buffer.alloc(6);
    data[0] = 5;
    data[1] = buttons;
    data.writeUInt16BE(x, 2);
    data.writeUInt16BE(y, 4);
    this.write(data);
  }
  key(keysym: number, down: boolean) {
    const data = Buffer.alloc(8);
    data[0] = 4;
    data[1] = down ? 1 : 0;
    data.writeUInt32BE(keysym, 4);
    this.write(data);
  }
  text(text: string) {
    for (const character of text) {
      const point = character.codePointAt(0)!;
      const keysym =
        point === 10 ? 0xff0d : point === 9 ? 0xff09 : point < 256 ? point : 0x01000000 | point;
      this.key(keysym, true);
      this.key(keysym, false);
    }
  }
  chord(text: string) {
    const keys: Record<string, number> = {
      Enter: 0xff0d,
      Return: 0xff0d,
      Tab: 0xff09,
      Escape: 0xff1b,
      BackSpace: 0xff08,
      Delete: 0xffff,
      Left: 0xff51,
      Up: 0xff52,
      Right: 0xff53,
      Down: 0xff54,
      Home: 0xff50,
      End: 0xff57,
      PageUp: 0xff55,
      PageDown: 0xff56,
      Shift: 0xffe1,
      Control: 0xffe3,
      Ctrl: 0xffe3,
      Alt: 0xffe9,
      Super: 0xffeb,
      Meta: 0xffe7,
      space: 32,
    };
    const codes = text
      .split('+')
      .map(
        (key) =>
          keys[key] ||
          (/^F(?:[1-9]|1[0-2])$/.test(key)
            ? 0xffbd + Number(key.slice(1))
            : key.length === 1
              ? key.codePointAt(0)!
              : 0),
      );
    if (codes.some((code) => !code)) throw new Error('Unsupported key name.');
    codes.forEach((code) => this.key(code, true));
    codes.reverse().forEach((code) => this.key(code, false));
  }
  async drain() {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.alloc(0), (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  close() {
    clearTimeout(this.deadline);
    this.socket.destroy();
  }
}
