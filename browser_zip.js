/**
 * Клас WorkerPool – пул воркерів для обчислення CRC32 у потоці.
 */
class WorkerPool {
  constructor(numWorkers) {
    this.numWorkers = numWorkers;
    this.workers = [];
    this.taskQueue = [];
    this.taskResolvers = new Map();
    this.nextTaskId = 0;

    // Сценарій воркера: обчислює CRC32 для Blob по чанках.
    const workerScript = `
      function createCRC32Table() {
        const table = new Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let j = 0; j < 8; j++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          }
          table[i] = c;
        }
        return table;
      }

      self.onmessage = async function(e) {
        if (e.data.type === 'calculateCRC32Stream') {
          const blob = e.data.blob;
          const chunkSize = e.data.chunkSize || 65536; // 64KB за замовчуванням
          const table = createCRC32Table();
          let crc = 0xffffffff;
          let offset = 0;
          try {
            while (offset < blob.size) {
              const slice = blob.slice(offset, offset + chunkSize);
              const buffer = await slice.arrayBuffer();
              const data = new Uint8Array(buffer);
              for (let i = 0; i < data.length; i++) {
                crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
              }
              offset += chunkSize;
            }
            const result = (crc ^ 0xffffffff) >>> 0;
            self.postMessage({ type: 'crc32StreamResult', id: e.data.id, crc32: result });
          } catch (err) {
            self.postMessage({ type: 'crc32Error', id: e.data.id, error: err.toString() });
          }
        }
      };
    `;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(url);
      worker.inUse = false;
      worker.onmessage = (e) => {
        const id = e.data.id;
        if (e.data.type === 'crc32StreamResult') {
          if (this.taskResolvers.has(id)) {
            this.taskResolvers.get(id).resolve(e.data.crc32);
            this.taskResolvers.delete(id);
          }
        } else if (e.data.type === 'crc32Error') {
          if (this.taskResolvers.has(id)) {
            this.taskResolvers.get(id).reject(new Error(e.data.error));
            this.taskResolvers.delete(id);
          }
        }
        // Позначаємо воркер як вільний та обробляємо наступну задачу з черги
        worker.inUse = false;
        this._processQueue();
      };
      this.workers.push(worker);
    }
  }

  _processQueue() {
    if (this.taskQueue.length === 0) return;
    const freeWorker = this.workers.find(w => !w.inUse);
    if (!freeWorker) return;
    const task = this.taskQueue.shift();
    freeWorker.inUse = true;
    freeWorker.postMessage(task.message);
  }

  /**
   * Запускає обчислення CRC32 для Blob з потоковою обробкою по чанках.
   * @param {Blob} blob – Оброблюваний файл
   * @param {number} chunkSize – Розмір чанку (у байтах)
   * @returns {Promise<number>} – Обчислене значення CRC32
   */
  runCRC32Stream(blob, chunkSize) {
    return new Promise((resolve, reject) => {
      const id = this.nextTaskId++;
      const message = { type: 'calculateCRC32Stream', id, blob, chunkSize };
      this.taskResolvers.set(id, { resolve, reject });
      const freeWorker = this.workers.find(w => !w.inUse);
      if (freeWorker) {
        freeWorker.inUse = true;
        freeWorker.postMessage(message);
      } else {
        this.taskQueue.push({ message });
      }
    });
  }

  terminate() {
    this.workers.forEach(worker => worker.terminate());
  }
}

/**
 * Клас BrowserZip – бібліотека для формування ZIP‑архіву.
 * Генеруються локальні заголовки, вміст файлів, запис центрального каталогу та EOCD.
 * Використовується WorkerPool для потокового обчислення CRC32 для великих файлів (Blob).
 */
class BrowserZip {
  constructor() {
    // Зберігаємо записи файлів у Map (унікальність та швидкий доступ)
    this.files = new Map();
    const numWorkers = navigator.hardwareConcurrency || 4;
    this.workerPool = new WorkerPool(numWorkers);
  }

  /**
   * Синхронно обчислює CRC32 для даних (Uint8Array).
   * Використовує статичну таблицю, що ініціалізується один раз.
   */
  static computeCRC32(data) {
    const table = BrowserZip.crc32Table || (BrowserZip.crc32Table = new Array(256)
      .fill(0)
      .map((_, i) => {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return c;
      }));
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Додає файл до архіву.
   * @param {string} name – Ім'я файлу.
   * @param {Blob|string|Uint8Array} content – Вміст файлу.
   */
  async addFile(name, content) {
    if (this.files.has(name)) {
      console.warn(`Файл "${name}" вже доданий до архіву. Пропускаємо...`);
      return;
    }
    const utf8Encoder = new TextEncoder();
    const encodedName = utf8Encoder.encode(name);
    let storedContent;
    let crc32 = null;
    
    if (content instanceof Blob) {
      // Для великих файлів зберігаємо об’єкт Blob – відстрочене завантаження даних.
      storedContent = content;
    } else if (typeof content === "string") {
      storedContent = utf8Encoder.encode(content);
      crc32 = BrowserZip.computeCRC32(storedContent);
    } else if (content instanceof Uint8Array) {
      storedContent = content;
      crc32 = BrowserZip.computeCRC32(storedContent);
    } else {
      throw new Error("Unsupported content type. Must be Blob, string, or Uint8Array.");
    }
    
    // Запис файлу для подальшої генерації архіву.
    const fileRecord = {
      name,
      encodedName,           // Uint8Array із закодованою назвою
      content: storedContent, // Blob або Uint8Array
      crc32,                 // Для Blob буде обчислено під час генерації
      size: 0,               // Розмір файлу визначається під час генерації
    };

    this.files.set(name, fileRecord);
  }

  // Створює локальний заголовок файлу у форматі ZIP.
  createLocalFileHeader(encodedName, fileSize, crc32) {
    const header = new Uint8Array(30 + encodedName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);    // Signature локального заголовку
    view.setUint16(4, 0x0014, true);         // Версія, необхідна для розархівації
    view.setUint16(6, 0x0800, true);         // Загальний прапорець (UTF-8)
    view.setUint16(8, 0x0000, true);         // Метод стиснення (0 = Store)
    view.setUint32(10, 0x00000000, true);    // Часова мітка
    view.setUint32(14, crc32, true);         // CRC-32
    view.setUint32(18, fileSize, true);      // Стиснутий розмір
    view.setUint32(22, fileSize, true);      // Нестиснутий розмір
    view.setUint16(26, encodedName.length, true); // Довжина імені файлу
    view.setUint16(28, 0x0000, true);        // Довжина додаткового поля
    header.set(encodedName, 30);
    return header;
  }

  // Створює запис центрального каталогу для файлу.
  createCentralDirectoryHeader(fileRecord, localHeaderOffset) {
    const encodedName = fileRecord.encodedName;
    const header = new Uint8Array(46 + encodedName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true); // Signature центрального каталогу
    view.setUint16(4, 0x0014, true);      // Версія створення
    view.setUint16(6, 0x0014, true);      // Версія, необхідна для розархівації
    view.setUint16(8, 0x0800, true);       // Загальний прапорець (UTF-8)
    view.setUint16(10, 0x0000, true);      // Метод стиснення
    view.setUint32(12, 0x00000000, true);  // Часова мітка
    view.setUint32(16, fileRecord.crc32, true); // CRC-32
    view.setUint32(20, fileRecord.size, true);  // Стиснутий розмір
    view.setUint32(24, fileRecord.size, true);  // Нестиснутий розмір
    view.setUint16(28, encodedName.length, true); // Довжина імені файлу
    view.setUint16(30, 0x0000, true);      // Довжина додаткового поля
    view.setUint16(32, 0x0000, true);      // Довжина коментаря
    view.setUint16(34, 0x0000, true);      // Номер диска
    view.setUint16(36, 0x0000, true);      // Внутрішні атрибути
    view.setUint32(38, 0x00000000, true);  // Зовнішні атрибути
    view.setUint32(42, localHeaderOffset, true); // Зміщення локального заголовку
    header.set(encodedName, 46);
    return header;
  }

  /**
   * Генерує ZIP‑архів як ReadableStream.
   * Це дозволяє послідовно формувати вихідний потік, не завантажуючи весь архів в пам’ять.
   * @param {number} [chunkSizeForCRC=65536] – Розмір чанку для обчислення CRC32 (у байтах)
   * @returns {ReadableStream} – потік з даними ZIP‑архіву.
   */
  generateZipStream(chunkSizeForCRC = 65536) {
    const self = this;
    const fileRecords = Array.from(this.files.values());
    const centralDirectoryEntries = [];
    let offset = 0;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const fileRecord of fileRecords) {
            // Визначаємо розмір файлу
            let fileSize = 0;
            if (fileRecord.content instanceof Blob) {
              fileSize = fileRecord.content.size;
            } else {
              fileSize = fileRecord.content.length;
            }
            fileRecord.size = fileSize;

            // Обчислення CRC32:
            // • Для Blob – обчислюємо потоково через worker pool.
            // • Для інших типів – значення вже обчислено.
            if (fileRecord.content instanceof Blob) {
              fileRecord.crc32 = await self.workerPool.runCRC32Stream(fileRecord.content, chunkSizeForCRC);
            }

            // Створюємо локальний заголовок файлу
            const localHeader = self.createLocalFileHeader(
              fileRecord.encodedName,
              fileSize,
              fileRecord.crc32
            );
            controller.enqueue(localHeader);
            offset += localHeader.byteLength;

            // Потокове зчитування вмісту файлу з обробкою помилок
            if (fileRecord.content instanceof Blob) {
              const reader = fileRecord.content.stream().getReader();
              while (true) {
                let result;
                try {
                  result = await reader.read();
                } catch (err) {
                  controller.error(new Error("Помилка зчитування файлу: " + err));
                  return;
                }
                if (result.done) break;
                controller.enqueue(result.value);
                offset += result.value.byteLength;
              }
            } else {
              controller.enqueue(fileRecord.content);
              offset += fileRecord.content.byteLength || fileRecord.content.length;
            }

            // Розраховуємо зміщення для запису у центральному каталозі
            const localHeaderOffset = offset - (localHeader.byteLength + fileRecord.size);
            const centralHeader = self.createCentralDirectoryHeader(fileRecord, localHeaderOffset);
            centralDirectoryEntries.push(centralHeader);
          }

          // Додаємо записи центрального каталогу
          let centralDirSize = 0;
          for (const entry of centralDirectoryEntries) {
            controller.enqueue(entry);
            centralDirSize += entry.byteLength;
          }
          const centralDirOffset = offset;
          offset += centralDirSize;

          // Створюємо кінцевий запис центрального каталозію (EOCD)
          const endRecord = new Uint8Array(22);
          const view = new DataView(endRecord.buffer);
          view.setUint32(0, 0x06054b50, true); // Підпис EOCD
          view.setUint16(4, 0, true);          // Номер диска
          view.setUint16(6, 0, true);          // Диск з початком центрального каталогу
          view.setUint16(8, fileRecords.length, true);  // Загальна кількість записів
          view.setUint16(10, fileRecords.length, true); // Загальна кількість записів
          view.setUint32(12, centralDirSize, true);     // Розмір центрального каталогу
          view.setUint32(16, centralDirOffset, true);     // Зміщення центрального каталогу
          view.setUint16(20, 0, true);         // Довжина коментаря
          controller.enqueue(endRecord);
          offset += endRecord.byteLength;

          // Очищення пам’яті: звільняємо посилання на файли
          self.files.clear();
          controller.close();
        } catch (error) {
          controller.error(new Error("Помилка генерації архіву: " + error));
        }
      }
    });
    return stream;
  }

  /**
   * Завантажує ZIP‑архів.
   * Архів генерується за допомогою стрімового API, після чого створюється посилання для завантаження.
   * @param {string} fileName – Ім'я вихідного ZIP‑файлу.
   * @param {number} [chunkSizeForCRC=65536] – Розмір чанку для обчислення CRC32 (у байтах)
   */
  async downloadZip(fileName, chunkSizeForCRC = 65536) {
    const zipStream = this.generateZipStream(chunkSizeForCRC);
    const response = new Response(zipStream);
    const zipBlob = await response.blob();
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    // Звільняємо URL після використання
    URL.revokeObjectURL(url);
  }

  /**
   * Завершує роботу бібліотеки та звільняє ресурси (воркери).
   */
  terminate() {
    this.workerPool.terminate();
  }
}

// Приклад використання:
//
// (async () => {
//   const zip = new BrowserZip();
//   // Додаємо невеликий текстовий файл
//   await zip.addFile("example.txt", "Це приклад вмісту.");
//   // Додаємо великий файл як Blob (наприклад, отриманий з file input)
//   // await zip.addFile("bigFile.bin", someLargeBlob);
//
//   // Завантаження архіву
//   await zip.downloadZip("archive.zip");
//   // Звільнюємо ресурси
//   zip.terminate();
// })();
