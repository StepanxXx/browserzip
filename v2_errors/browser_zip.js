class BrowserZip {
  constructor() {
    this.files = new Map();
    console.log("BrowserZip створено!");
  }

  async addFile(name, content) {
    console.log(`Додається файл: ${name}, тип контенту: ${typeof content}`);

    const utf8Encoder = new TextEncoder();
    const encodedName = utf8Encoder.encode(name);

    let encodedContent;
    if (content instanceof Blob) {
      encodedContent = new Uint8Array(await content.arrayBuffer());
      console.log(`BLOB-файл "${name}" успішно перетворено на Uint8Array!`);
    } else if (typeof content === "string") {
      encodedContent = utf8Encoder.encode(content);
    } else {
      encodedContent = content;
    }

    if (this.files.has(name)) {
      console.warn(`Файл "${name}" вже доданий до архіву. Пропускаємо...`);
      return;
    }

    const crc32 = this.calculateCRC32(encodedContent);
    const fileHeader = this.createFileHeader(encodedName, encodedContent, crc32);
    this.files.set(name, { header: fileHeader, content: encodedContent, crc32 });

    console.log(`Файл "${name}" успішно додано до архіву!`);
  }

  calculateCRC32(data) {
    const table = Array.from({ length: 256 }, (_, i) => {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return c;
    });

    let crc = 0xffffffff;
    for (const byte of data) {
      crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  createFileHeader(fileName, content, crc32) {
    const fileSize = content.length;
    const header = new Uint8Array(30 + fileName.length);
    const view = new DataView(header.buffer);

    view.setUint32(0, 0x04034b50, true); // Signature
    view.setUint16(4, 0x0014, true); // Version needed to extract
    view.setUint16(6, 0x0800, true); // General purpose bit flag
    view.setUint16(8, 0x0000, true); // Compression method
    view.setUint32(14, crc32, true); // CRC-32
    view.setUint32(18, fileSize, true); // Compressed size
    view.setUint32(22, fileSize, true); // Uncompressed size
    view.setUint16(26, fileName.length, true);

    header.set(fileName, 30);

    console.log(`Заголовок для файлу "${new TextDecoder().decode(fileName)}" створено!`);
    return header;
  }

  async generateZipStream() {
    const centralDirectory = [];
    let offset = 0;

    console.log("Починається генерація ZIP архіву...");

    const stream = new ReadableStream({
      start: (controller) => {
        for (const [name, file] of this.files) {
          console.log(`Додається файл у потік: ${name}`);
          controller.enqueue(file.header);
          controller.enqueue(file.content);

          const centralHeader = new Uint8Array(46 + name.length);
          const view = new DataView(centralHeader.buffer);

          view.setUint32(0, 0x02014b50, true); // Central directory signature
          view.setUint16(4, 0x0014, true); // Version made by
          view.setUint16(6, 0x0014, true); // Version needed to extract
          view.setUint16(8, 0x0800, true); // UTF-8 encoding flag
          view.setUint16(10, 0x0000, true); // Compression method
          view.setUint32(16, file.crc32, true); // CRC-32
          view.setUint32(20, file.content.length, true); // Compressed size
          view.setUint32(24, file.content.length, true); // Uncompressed size
          view.setUint16(28, name.length, true); // File name length
          view.setUint16(30, 0x0000, true); // Extra field length
          view.setUint16(32, 0x0000, true); // File comment length
          view.setUint16(34, 0x0000, true); // Disk number start
          view.setUint16(36, 0x0000, true); // Internal file attributes
          view.setUint32(38, 0x00000000, true); // External file attributes
          view.setUint32(42, offset, true); // Offset of local header

          centralHeader.set(new TextEncoder().encode(name), 46);
          centralDirectory.push(centralHeader);
          offset += file.header.length + file.content.length;
        }

        centralDirectory.forEach(entry => controller.enqueue(entry));

        const centralDirEnd = new Uint8Array(22);
        const view = new DataView(centralDirEnd.buffer);
        view.setUint32(0, 0x06054b50, true); // End of central directory signature
        view.setUint16(8, this.files.size, true); // Total number of entries
        view.setUint16(10, this.files.size, true); // Total entries in central directory
        view.setUint32(12, offset, true); // Size of central directory
        view.setUint32(16, offset, true); // Offset of central directory
        controller.enqueue(centralDirEnd);
        controller.close();

        console.log("Генерація ZIP архіву завершена!");
      }
    });

    return new Response(stream, { headers: { "Content-Type": "application/zip" } });
  }

  async downloadZipStream(fileName) {
    try {
      const response = await this.generateZipStream();
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const downloadLink = document.createElement("a");
      downloadLink.href = url;
      downloadLink.download = fileName;
      downloadLink.click();

      URL.revokeObjectURL(url);

      console.log(`Архів "${fileName}" успішно завантажено!`);
    } catch (error) {
      console.error("Помилка під час завантаження ZIP архіву:", error);
    }
  }
}
