export function ramFixture() {
  const ram = new Uint8Array(2048);
  ram[0x770] = 1;
  ram[0x772] = 3;
  ram[0x0e] = 8;
  ram[0xb5] = 1;
  ram[0xce] = 192;
  ram[0x754] = 1;
  ram[0x86] = 40;
  ram[0x75a] = 2;
  ram[0x7f8] = 4;
  for (let column = 0; column < 16; column++)
    ram[0x500 + 12 * 16 + column] = 0x54;
  return ram;
}

export function answer(action = 'right_run') {
  return {
    answers: {
      move: { type: 'choice', choice: action },
      jump_needed: { type: 'noul', noul: 0.2 },
    },
  };
}

// Original, minimal homebrew 6502 program authored for this test. No Nintendo
// code, tiles, music or game data. It seeds RAM and increments X on each NMI.
export function homebrewROM({ deathX } = {}) {
  const rom = Buffer.alloc(40976);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 1]);
  const code = [0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xa9, 0, 0xa2, 0];
  const clear = code.length;
  for (let page = 0; page < 8; page++) code.push(0x9d, 0, page);
  code.push(0xe8, 0xd0, (clear - (code.length + 3)) & 255);
  const ram = ramFixture();
  for (let address = 0; address < ram.length; address++) {
    if (ram[address])
      code.push(0xa9, ram[address], 0x8d, address & 255, address >> 8);
  }
  code.push(0xa9, 0x80, 0x8d, 0, 0x20);
  const loop = 0x8000 + code.length;
  code.push(0x4c, loop & 255, loop >> 8);
  const nmi = 0x8000 + code.length;
  code.push(0xee, 0x86, 0);
  if (deathX !== undefined)
    code.push(
      0xad,
      0,
      7,
      0xf0,
      10,
      0xa5,
      0x86,
      0xc9,
      deathX,
      0x90,
      4,
      0xa9,
      11,
      0x85,
      0x0e,
    );
  code.push(0x40);
  rom.set(code, 16);
  rom.writeUInt16LE(nmi, 16 + 0x7ffa);
  rom.writeUInt16LE(0x8000, 16 + 0x7ffc);
  rom.writeUInt16LE(nmi, 16 + 0x7ffe);
  return rom;
}
