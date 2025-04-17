const BrowserZip = (function() {
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
     * @param {Blob} blob – оброблюваний файл
     * @param {number} chunkSize – розмір чанку (у байтах)
     * @returns {Promise<number>} – обчислене значення CRC32
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
   * Клас BrowserZip – бібліотека для формування ZIP‑архівів із підтримкою Zip64 та створенням директорій.
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
     * @param {string} name – Ім'я файлу (включаючи шлях, наприклад, "folder/file.txt").
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
      
      const fileRecord = {
        name,
        encodedName,           // Uint8Array із закодованою назвою
        content: storedContent, // Blob або Uint8Array
        crc32,                 // Для Blob буде обчислено під час генерації
        size: 0,               // Розмір файлу визначається під час генерації
        isDirectory: false
      };

      this.files.set(name, fileRecord);
    }

    /**
     * Додає папку до архіву.
     * @param {string} folderName – Ім'я папки (наприклад, "folder/"). Якщо не закінчується на "/", додається автоматично.
     */
    async addFolder(folderName) {
      if (!folderName.endsWith("/")) {
        folderName += "/";
      }
      if (this.files.has(folderName)) {
        console.warn(`Папка "${folderName}" вже додана до архіву. Пропускаємо...`);
        return;
      }
      const utf8Encoder = new TextEncoder();
      const encodedName = utf8Encoder.encode(folderName);
      // Директорія не має вмісту, розмір = 0, CRC = 0.
      const fileRecord = {
        name: folderName,
        encodedName,
        content: new Uint8Array(0),
        crc32: 0,
        size: 0,
        isDirectory: true
      };
      this.files.set(folderName, fileRecord);
    }

    /**
     * Створює локальний заголовок файлу у форматі ZIP з підтримкою Zip64.
     * Якщо fileSize перевищує 0xFFFFFFFF, у поля розміру запису записуємо 0xFFFFFFFF,
     * а фактичний розмір додаємо у Zip64 extra field.
     * @param {Uint8Array} encodedName – закодоване ім'я файлу.
     * @param {number} fileSize – розмір файлу.
     * @param {number} crc32 – обчислений CRC32.
     * @returns {Uint8Array} – локальний заголовок файлу.
     */
    createLocalFileHeader(encodedName, fileSize, crc32) {
      const useZip64 = fileSize >= 0xFFFFFFFF;
      const extraFieldSize = useZip64 ? 20 : 0;
      const headerSize = 30 + encodedName.length + extraFieldSize;
      const header = new Uint8Array(headerSize);
      const view = new DataView(header.buffer);
    
      view.setUint32(0, 0x04034b50, true);         // Signature локального заголовку
      view.setUint16(4, useZip64 ? 0x002D : 0x0014, true); // Версія для розархівації (45 для Zip64)
      view.setUint16(6, 0x0800, true);              // Загальний прапорець (UTF-8)
      view.setUint16(8, 0x0000, true);              // Метод стиснення (0 = Store)
      view.setUint32(10, 0x00000000, true);         // Часова мітка
      view.setUint32(14, crc32, true);              // CRC-32
      const sizeField = useZip64 ? 0xFFFFFFFF : fileSize;
      view.setUint32(18, sizeField, true);          // Стиснутий розмір
      view.setUint32(22, sizeField, true);          // Нестиснутий розмір
      view.setUint16(26, encodedName.length, true); // Довжина імені файлу
      view.setUint16(28, extraFieldSize, true);     // Довжина додаткового поля
      header.set(encodedName, 30);
    
      if (useZip64) {
        let pos = 30 + encodedName.length;
        // Запис Zip64 extra field: ID (0x0001), довжина (16 байт),
        // 64-бітний нестиснутий розмір, 64-бітний стиснутий розмір.
        view.setUint16(pos, 0x0001, true); pos += 2;
        view.setUint16(pos, 16, true); pos += 2;
        view.setBigUint64(pos, BigInt(fileSize), true); pos += 8;
        view.setBigUint64(pos, BigInt(fileSize), true); pos += 8;
      }
      return header;
    }

    /**
     * Створює запис центрального каталогу для файлу з підтримкою Zip64.
     * Для директорій зовнішній атрибут встановлюється так, щоб відзначати об'єкт як папку (наприклад, 0x10 << 16).
     * @param {Object} fileRecord – запис файлу із всіма даними.
     * @param {number} localHeaderOffset – зміщення локального заголовку.
     * @returns {Uint8Array} – запис центрального каталогу.
     */
    createCentralDirectoryHeader(fileRecord, localHeaderOffset) {
      const encodedName = fileRecord.encodedName;
      const useZip64 = fileRecord.size >= 0xFFFFFFFF;
      const extraFieldSize = useZip64 ? 20 : 0;
      const headerSize = 46 + encodedName.length + extraFieldSize;
      const header = new Uint8Array(headerSize);
      const view = new DataView(header.buffer);
    
      view.setUint32(0, 0x02014b50, true);         // Signature запису центрального каталогу
      view.setUint16(4, useZip64 ? 0x002D : 0x0014, true); // Версія створення
      view.setUint16(6, useZip64 ? 0x002D : 0x0014, true); // Версія для розархівації
      view.setUint16(8, 0x0800, true);              // Загальний прапорець (UTF-8)
      view.setUint16(10, 0x0000, true);             // Метод стиснення
      view.setUint32(12, 0x00000000, true);         // Часова мітка
      view.setUint32(16, fileRecord.crc32, true);   // CRC-32
      const sizeField = useZip64 ? 0xFFFFFFFF : fileRecord.size;
      view.setUint32(20, sizeField, true);          // Стиснутий розмір
      view.setUint32(24, sizeField, true);          // Нестиснутий розмір
      view.setUint16(28, encodedName.length, true); // Довжина імені файлу
      view.setUint16(30, extraFieldSize, true);     // Довжина додаткового поля
      view.setUint16(32, 0x0000, true);             // Довжина коментаря
      view.setUint16(34, 0x0000, true);             // Номер диска
      view.setUint16(36, 0x0000, true);             // Внутрішні атрибути
      // Якщо це директорія, встановлюємо зовнішні атрибути, що позначають її як папку (MS-DOS: 0x10)
      view.setUint32(38, fileRecord.isDirectory ? (0x10 << 16) : 0x00000000, true);
      const offsetField = useZip64 ? 0xFFFFFFFF : localHeaderOffset;
      view.setUint32(42, offsetField, true);        // Зміщення локального заголовку
      header.set(encodedName, 46);
    
      if (useZip64) {
        let pos = 46 + encodedName.length;
        view.setUint16(pos, 0x0001, true); pos += 2;
        view.setUint16(pos, 16, true); pos += 2;
        view.setBigUint64(pos, BigInt(fileRecord.size), true); pos += 8;
        view.setBigUint64(pos, BigInt(fileRecord.size), true); pos += 8;
      }
      return header;
    }

    /**
     * Створює кінцеві записи архіву.
     * Якщо характеристики (зміщення, розмір каталогу, кількість записів) перевищують ліміти ZIP,
     * генерується Zip64 EOCD Record, Zip64 EOCD Locator та стандартний EOCD Record з максимальними значеннями.
     * @param {number} centralDirectoryOffset – Зміщення центрального каталогу.
     * @param {number} centralDirectorySize – Розмір центрального каталогу.
     * @param {number} totalEntries – Загальна кількість записів.
     * @returns {Array<Uint8Array>} – Масив, що містить кінцеві записи.
     */
    createEndRecords(centralDirectoryOffset, centralDirectorySize, totalEntries) {
      const useZip64 = (centralDirectoryOffset >= 0xFFFFFFFF ||
                        centralDirectorySize >= 0xFFFFFFFF ||
                        totalEntries >= 0xFFFF);
      if (useZip64) {
        // Zip64 End of Central Directory Record (56 байт)
        const zip64End = new Uint8Array(56);
        const viewZip64 = new DataView(zip64End.buffer);
        viewZip64.setUint32(0, 0x06064b50, true);            // Сигнатура Zip64 EOCD Record
        viewZip64.setBigUint64(4, 44n, true);                  // Розмір запису (44 байти, що слідують)
        viewZip64.setUint16(12, 0x002D, true);                 // Версія створення (45)
        viewZip64.setUint16(14, 0x002D, true);                 // Версія, необхідна для розархівації (45)
        viewZip64.setUint32(16, 0, true);                      // Номер цього диска
        viewZip64.setUint32(20, 0, true);                      // Диск, на якому починається каталог
        viewZip64.setBigUint64(24, BigInt(totalEntries), true); // Кількість записів на цьому диску
        viewZip64.setBigUint64(32, BigInt(totalEntries), true); // Загальна кількість записів
        viewZip64.setBigUint64(40, BigInt(centralDirectorySize), true); // Розмір центрального каталогу
        viewZip64.setBigUint64(48, BigInt(centralDirectoryOffset), true); // Зміщення центрального каталогу

        // Zip64 End of Central Directory Locator (20 байт)
        const zip64Locator = new Uint8Array(20);
        const viewLocator = new DataView(zip64Locator.buffer);
        viewLocator.setUint32(0, 0x07064b50, true);          // Сигнатура Zip64 EOCD Locator
        viewLocator.setUint32(4, 0, true);                     // Номер диска, на якому знаходиться Zip64 EOCD Record
        viewLocator.setBigUint64(8, BigInt(centralDirectoryOffset + centralDirectorySize), true); // Зміщення Zip64 EOCD Record
        viewLocator.setUint32(16, 1, true);                    // Кількість дисків

        // Стандартний EOCD Record (22 байти) з максимально можливими значеннями
        const eocd = new Uint8Array(22);
        const viewEOCD = new DataView(eocd.buffer);
        viewEOCD.setUint32(0, 0x06054b50, true);             // Сигнатура EOCD
        viewEOCD.setUint16(4, 0, true);                      // Номер цього диска
        viewEOCD.setUint16(6, 0, true);                      // Диск з початком каталогу
        viewEOCD.setUint16(8, 0xFFFF, true);                 // Кількість записів на цьому диску (максимум)
        viewEOCD.setUint16(10, 0xFFFF, true);                // Загальна кількість записів (максимум)
        viewEOCD.setUint32(12, 0xFFFFFFFF, true);            // Розмір каталогу (максимум)
        viewEOCD.setUint32(16, 0xFFFFFFFF, true);            // Зміщення каталогу (максимум)
        viewEOCD.setUint16(20, 0, true);                     // Довжина коментаря
        return [zip64End, zip64Locator, eocd];
      } else {
        const eocd = new Uint8Array(22);
        const viewEOCD = new DataView(eocd.buffer);
        viewEOCD.setUint32(0, 0x06054b50, true);             // Сигнатура EOCD
        viewEOCD.setUint16(4, 0, true);                      // Номер цього диска
        viewEOCD.setUint16(6, 0, true);                      // Диск з початком каталогу
        viewEOCD.setUint16(8, totalEntries, true);           // Кількість записів на цьому диску
        viewEOCD.setUint16(10, totalEntries, true);          // Загальна кількість записів
        viewEOCD.setUint32(12, centralDirectorySize, true);  // Розмір каталогу
        viewEOCD.setUint32(16, centralDirectoryOffset, true); // Зміщення каталогу
        viewEOCD.setUint16(20, 0, true);                     // Довжина коментаря
        return [eocd];
      }
    }

    /**
     * Генерує ZIP‑архів як ReadableStream.
     * Потік формується шляхом послідовного додавання локальних заголовків, вмісту файлів,
     * записів центрального каталогу та кінцевих записів (EOCD та Zip64 EOCD, якщо потрібно).
     * @param {number} [chunkSizeForCRC=65536] – Розмір чанку для обчислення CRC32 (у байтах)
     * @param {function} [onProgress=null] – Функція зворотного виклику для оновлення прогресу
     * @returns {ReadableStream} – Потік з даними ZIP‑архіву.
     */
    generateZipStream(chunkSizeForCRC = 65536, onProgress = null) {
      const self = this;
      const fileRecords = Array.from(this.files.values());
      const centralDirectoryEntries = [];
      let offset = 0;
      let totalSize = 0;
    
      // Обчислюємо загальний розмір файлів
      for (const fileRecord of fileRecords) {
        totalSize += fileRecord.isDirectory
          ? 0
          : (fileRecord.content instanceof Blob
              ? fileRecord.content.size
              : fileRecord.content.length);
      }
    
      const stream = new ReadableStream({
        async start(controller) {
          try {
            let processedSize = 0;
            

            for (const fileRecord of fileRecords) {
              let fileSize = fileRecord.isDirectory
                ? 0
                : (fileRecord.content instanceof Blob
                    ? fileRecord.content.size
                    : fileRecord.content.length);
              fileRecord.size = fileSize;
    
              // Обчислення CRC32:
              // – Для Blob (файлів) – потокове обчислення через WorkerPool.
              // – Для директорій або інших типів – значення вже обчислено або 0.
              if (!fileRecord.isDirectory && (fileRecord.content instanceof Blob)) {
                fileRecord.crc32 = await self.workerPool.runCRC32Stream(fileRecord.content, chunkSizeForCRC);
              }
    
              // Створення локального заголовку
              const localHeader = self.createLocalFileHeader(
                fileRecord.encodedName,
                fileSize,
                fileRecord.crc32 || 0
              );
              controller.enqueue(localHeader);
              offset += localHeader.byteLength;
    
            // Для файлів з даними – потокове зчитування вмісту.
              if (!fileRecord.isDirectory) {
                if (fileRecord.content instanceof Blob) {
                  const reader = fileRecord.content.stream().getReader();
                  while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    controller.enqueue(result.value);
                    offset += result.value.byteLength;
                    processedSize += result.value.byteLength;
    
                    // Оновлюємо прогрес
                    if (onProgress) {
                      const progress = Math.min(
                        Math.round((processedSize / totalSize) * 100),
                        100
                      );
                      onProgress(progress);
                    }
                  }
                } else {
                  controller.enqueue(fileRecord.content);
                  offset += fileRecord.content.byteLength || fileRecord.content.length;
                  processedSize += fileRecord.content.byteLength || fileRecord.content.length;
    
                  // Оновлюємо прогрес
                  if (onProgress) {
                    const progress = Math.min(
                      Math.round((processedSize / totalSize) * 100),
                      100
                    );
                    onProgress(progress);
                  }
                }
              }
    
              const localHeaderOffset = offset - (localHeader.byteLength + fileRecord.size);
              const centralHeader = self.createCentralDirectoryHeader(fileRecord, localHeaderOffset);
              centralDirectoryEntries.push(centralHeader);
            }
    
            let centralDirSize = 0;
            for (const entry of centralDirectoryEntries) {
              controller.enqueue(entry);
              centralDirSize += entry.byteLength;
            }
            const centralDirOffset = offset;
            offset += centralDirSize;
    
            const endRecords = self.createEndRecords(centralDirOffset, centralDirSize, fileRecords.length);
            for (const rec of endRecords) {
              controller.enqueue(rec);
            }
            offset += endRecords.reduce((sum, rec) => sum + rec.byteLength, 0);
    
            // Очищення пам’яті: звільняємо записи
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
     * Генерується архів через ReadableStream, створюється Blob, генерується URL,
     * а потім симулюється клік для завантаження.
     * @param {string} fileName – Ім'я вихідного ZIP‑файлу.
     * @param {number} [chunkSizeForCRC=65536] – Розмір чанку для обчислення CRC32.
     * @param {function} [onProgress=null] – Функція зворотного виклику для оновлення прогресу
     */
    async downloadZip(fileName, chunkSizeForCRC = 65536, onProgress = null) {
      const zipStream = this.generateZipStream(chunkSizeForCRC, onProgress);
      const response = new Response(zipStream);
      const zipBlob = await response.blob();
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    }
    
    /**
     * Завершує роботу бібліотеки та звільняє ресурси (воркери).
     */
    terminate() {
      this.workerPool.terminate();
    }
  }
  return BrowserZip;
})();
// Приклад використання:
//
// (async () => {
//   const zip = new BrowserZip();
//   // Додаємо файл у корінь архіву
//   await zip.addFile("example.txt", "Це приклад вмісту.");
//   // Створюємо папку (директорію)
//   await zip.addFolder("folder/");
//   // Додаємо файл у створену папку
//   await zip.addFile("folder/info.txt", "Інформація у папці.");
//   // Завантаження архіву
//   await zip.downloadZip("archive.zip");
//   // Звільняємо ресурси
//   zip.terminate();
// })();
