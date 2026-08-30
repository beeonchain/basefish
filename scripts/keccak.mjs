// Dependency-free keccak-256 (Keccak-f[1600], rate 1088) — validated against ethers.keccak256.
// Used for ENS/Basename namehash in the fetch pipeline (GitHub Actions has no node_modules).
const RC = [1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = [], D = [];
    for (let x = 0; x < 5; x++) C[x] = A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = (A[x][y] ^ D[x]) & M64;
    const B = [[], [], [], [], []];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rotl(A[x][y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = (B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y])) & M64;
    A[0][0] = (A[0][0] ^ RC[round]) & M64;
  }
}

export function keccak256(bytes) { // Uint8Array -> Uint8Array(32)
  const rate = 136; // 1088 bits
  const A = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);
  // pad10*1 with keccak domain 0x01
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] = 0x01; padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      const x = i % 5, y = Math.floor(i / 5);
      A[x][y] = (A[x][y] ^ lane) & M64;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i % 5][Math.floor(i / 5)];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

const te = new TextEncoder();
const hex = (u8) => '0x' + [...u8].map(b => b.toString(16).padStart(2, '0')).join('');

export function namehash(name) { // ENS namehash -> 0x-hex
  let node = new Uint8Array(32);
  if (name) {
    for (const label of name.split('.').reverse()) {
      const lh = keccak256(te.encode(label));
      const cat = new Uint8Array(64); cat.set(node); cat.set(lh, 32);
      node = keccak256(cat);
    }
  }
  return hex(node);
}
