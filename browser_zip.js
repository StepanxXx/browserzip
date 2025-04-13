class BrowserZip {
  constructor() {
    this.files = new Map(); // Використовуємо Map для уникнення дублювання файлів
  }

  async addFile(name, content) {
    const utf8Encoder = new TextEncoder(); // Кодування назв файлів у форматі UTF-8
    const encodedName = utf8Encoder.encode(name); // Назва файлу коректно закодована в UTF-8
    const encodedContent = typeof content === "string"
      ? utf8Encoder.encode(content)
      : content;

    if (this.files.has(name)) {
      console.warn(`Файл "${name}" вже доданий до архіву. Пропускаємо...`);
      return; // Пропускаємо, якщо файл вже є
    }

    const crc32 = this.calculateCRC32(encodedContent);
    const fileHeader = this.createFileHeader(encodedName, encodedContent, crc32);
    this.files.set(name, { header: fileHeader, content: encodedContent, crc32 });
  }

  calculateCRC32(data) {
    const table = new Array(256).fill(0).map((_, i) => {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return c;
    });

    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  createFileHeader(fileName, content, crc32) {
    const fileSize = content.length;
    const header = new Uint8Array(30 + fileName.length);
    const view = new DataView(header.buffer);

    // Локальний заголовок файлу
    view.setUint32(0, 0x04034b50, true); // Signature
    view.setUint16(4, 0x0014, true); // Version needed to extract
    view.setUint16(6, 0x0800, true); // General purpose bit flag (UTF-8 encoding)
    view.setUint16(8, 0x0000, true); // Compression method (0 = Store)
    view.setUint32(10, 0x00000000, true); // Timestamp
    view.setUint32(14, crc32, true); // CRC-32
    view.setUint32(18, fileSize, true); // Compressed size
    view.setUint32(22, fileSize, true); // Uncompressed size
    view.setUint16(26, fileName.length, true); // File name length
    view.setUint16(28, 0x0000, true); // Extra field length

    header.set(fileName, 30);
    return header;
  }

  generateZip() {
    const zipParts = [];
    const centralDirectory = [];
    let offset = 0;

    // Додаємо файли до архіву
    this.files.forEach((file, name) => {
      zipParts.push(file.header, file.content);

      // Центральний каталог
      const centralHeader = new Uint8Array(46 + file.header.length - 30);
      const view = new DataView(centralHeader.buffer);

      view.setUint32(0, 0x02014b50, true); // Central directory signature
      view.setUint16(4, 0x0014, true); // Version made by
      view.setUint16(6, 0x0014, true); // Version needed to extract
      view.setUint16(8, 0x0800, true); // General purpose bit flag (UTF-8 encoding)
      view.setUint16(10, 0x0000, true); // Compression method
      view.setUint32(12, 0x00000000, true); // Timestamp
      view.setUint32(16, file.crc32, true); // CRC-32
      view.setUint32(20, file.content.length, true); // Compressed size
      view.setUint32(24, file.content.length, true); // Uncompressed size
      view.setUint16(28, file.header.length - 30, true); // File name length
      view.setUint16(30, 0x0000, true); // Extra field length
      view.setUint16(32, 0x0000, true); // File comment length
      view.setUint16(34, 0x0000, true); // Disk number start
      view.setUint16(36, 0x0000, true); // Internal file attributes
      view.setUint32(38, 0x00000000, true); // External file attributes
      view.setUint32(42, offset, true); // Offset of local header

      centralHeader.set(file.header.slice(30), 46);
      centralDirectory.push(centralHeader);
      offset += file.header.length + file.content.length;
    });

    // Додаємо центральний каталог і кінцевий запис
    const centralDirOffset = offset;
    centralDirectory.forEach(part => zipParts.push(part));
    const centralDirEnd = new Uint8Array(22);
    const endView = new DataView(centralDirEnd.buffer);

    endView.setUint32(0, 0x06054b50, true); // End of central directory signature
    endView.setUint16(4, 0x0000, true); // Number of this disk
    endView.setUint16(6, 0x0000, true); // Number of disk with central directory
    endView.setUint16(8, this.files.size, true); // Total number of entries
    endView.setUint16(10, this.files.size, true); // Total entries in central directory
    endView.setUint32(12, offset - centralDirOffset, true); // Size of central directory
    endView.setUint32(16, centralDirOffset, true); // Offset of central directory
    endView.setUint16(20, 0x0000, true); // Comment length

    zipParts.push(centralDirEnd);
    return new Blob(zipParts, { type: "application/zip" });
  }

   downloadZip(fileName) {
    const zipBlob = this.generateZip();
    const url = URL.createObjectURL(zipBlob);
  
    // Завантажуємо архів
    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.download = fileName;
    downloadLink.click();
  
    // Звільняємо об'єкт URL після використання
    URL.revokeObjectURL(url);
  }

}
