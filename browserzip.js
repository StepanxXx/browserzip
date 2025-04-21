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
        const crc32Table = (() => {
          const table = new Array(256);
          for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
              c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            table[i] = c;
          }
          return table;
        })();

        self.onmessage = async function(e) {
          if (e.data.type === 'calculateCRC32Stream') {
            const { id, blob, chunkSize = 65536 } = e.data; // Використовуємо переданий chunkSize
            let crc = 0xffffffff;
            let offset = 0;
            try {
              // Використовуємо вже обчислену таблицю
              const reader = blob.stream().getReader();
              while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const data = value; // value вже є Uint8Array
                  for (let i = 0; i < data.length; i++) {
                      crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
                  }
                  // Немає потреби відстежувати offset тут, reader робить це
              }

              // --- ПОКРАЩЕННЯ: Потокове читання замість slice/arrayBuffer ---
              // Старий код з blob.slice та arrayBuffer був менш ефективним для ReadableStream
              // const stream = blob.stream();
              // const reader = stream.getReader();
              // while (true) {
              //   const { done, value } = await reader.read();
              //   if (done) break;
              //   const data = value; // value є Uint8Array
              //   for (let i = 0; i < data.length; i++) {
              //     crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
              //   }
              // }
              // Попередня реалізація з slice була також робочою, але менш ідіоматичною для потоків
              const result = (crc ^ 0xffffffff) >>> 0;
              self.postMessage({ type: 'crc32StreamResult', id, crc32: result });
            } catch (err) {
              self.postMessage({
                type: 'crc32Error',
                id: e.data.id,
                error: { message: err.message, name: err.name /*, stack: err.stack */ } // Передаємо об'єкт помилки
              });
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
              const errorData = e.data.error || {};
              const error = new Error(errorData.message || 'CRC32 calculation failed in worker');
              error.name = errorData.name || 'WorkerError';
              this.taskResolvers.get(id).reject(error);
              this.taskResolvers.delete(id);
            }
          }
          // Додати обробку помилок самого воркера ---
          worker.onerror = (err) => {
            console.error(`Worker error: ${err.message}`, err);
            worker.inUse = false; // Позначити як вільний (хоча він може бути несправним)
            this._processQueue(); // Спробувати запустити інше завдання
          };
          worker.onmessageerror = (err) => {
              console.error("Worker message error:", err);
              // Помилка серіалізації / десеріалізації
          };
          // Позначаємо воркер як вільний та обробляємо наступну задачу з черги
          worker.inUse = false;
          this._processQueue();
        };
        this.workers.push(worker);
      }
      URL.revokeObjectURL(url);
    }

    _processQueue() {
      if (this.taskQueue.length === 0) return;
      // Знайти воркера, який не використовується і не мав критичної помилки (якщо така логіка додана)
      const freeWorker = this.workers.find(w => !w.inUse /* && !w.hasCrashed */);
      if (!freeWorker) return;
      const task = this.taskQueue.shift();
      freeWorker.inUse = true;
      // Додати обробку помилки postMessage, якщо потрібно
      try {
        freeWorker.postMessage(task.message);
      } catch (error) {
          console.error("Failed to post message to worker:", error);
          freeWorker.inUse = false;
          // Повернути завдання в чергу або відхилити його
          this.taskQueue.unshift(task); // Повернути на початок черги
          // Або:
          // if (this.taskResolvers.has(task.message.id)) {
          //    this.taskResolvers.get(task.message.id).reject(error);
          //    this.taskResolvers.delete(task.message.id);
          // }
          // Спробувати обробити чергу знову через деякий час або іншим воркером
          // setTimeout(() => this._processQueue(), 100);
      }
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
        // Додаємо в чергу, _processQueue знайде вільного воркера
        this.taskQueue.push({ message });
        this._processQueue(); // Запустити обробку черги
      });
    }

    terminate() {
      this.workers.forEach(worker => worker.terminate());
      this.workers = [];
      this.taskQueue = [];
      this.taskResolvers.clear(); // Очистити резолвери
    }
  }
  
  const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
  const CENTRAL_DIR_SIGNATURE = 0x02014b50;
  const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
  const ZIP64_END_OF_CENTRAL_DIR_SIGNATURE = 0x06064b50;
  const ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE = 0x07064b50;

  const VERSION_NEEDED_DEFAULT = 0x0014; // 20 = 2.0
  const VERSION_NEEDED_ZIP64 = 0x002D; // 45 = 4.5
  const METHOD_STORE = 0x0000;
  const FLAG_UTF8 = 0x0800;
  const MSDOS_DIR_ATTR = 0x10;

  const ZIP64_EXTRA_FIELD_ID = 0x0001;
  const ZIP64_EXTRA_FIELD_SIZE_NO_OFFSET = 16; // 2x 64-bit size
  const ZIP64_EXTRA_FIELD_SIZE_FULL = 28; // 2x 64-bit size, 1x 64-bit offset, 1x 32-bit disk num

  // Функція для конвертації JS Date в MS-DOS time/date format
  function dateToDos(jsDate) {
      const date = jsDate.getDate();
      const month = jsDate.getMonth() + 1;
      const year = jsDate.getFullYear();
      const hours = jsDate.getHours();
      const minutes = jsDate.getMinutes();
      const seconds = Math.floor(jsDate.getSeconds() / 2); // DOS time resolution is 2 seconds

      if (year < 1980) { // ZIP format doesn't support years before 1980
          return { dosTime: 0, dosDate: (1 << 5) | 1 }; // January 1st 1980
      }

      const dosTime = (hours << 11) | (minutes << 5) | seconds;
      const dosDate = ((year - 1980) << 9) | (month << 5) | date;

      return { dosTime, dosDate };
  }

  /**
   * Клас BrowserZip – бібліотека для формування ZIP‑архівів із підтримкою Zip64 та створенням директорій.
   */
  class BrowserZip {
    constructor() {
      // Зберігаємо записи файлів у Map (унікальність та швидкий доступ)
      this.files = new Map();
      const numWorkers = Math.min(6, navigator.hardwareConcurrency || 2); // Мінімум 2 для надійності?
      this.workerPool = new WorkerPool(numWorkers);
      // Кешована таблиця CRC32 всередині екземпляра або статична ---
      if (!BrowserZip.crc32Table) {
        BrowserZip.crc32Table = BrowserZip._createCRC32Table();
      }
    }

    // Допоміжний статичний метод для створення таблиці
    static _createCRC32Table() {
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
    /**
     * Синхронно обчислює CRC32 для даних (Uint8Array).
     */
    static computeCRC32(data) {
      // Використання статичної кешованої таблиці
      const table = BrowserZip.crc32Table || (BrowserZip.crc32Table = BrowserZip._createCRC32Table());
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
     * @param {object} [options] - Додаткові опції.
     * @param {Date} [options.lastModified=new Date()] - Час останньої модифікації.
     */
    async addFile(name, content, options = {}) {
      if (this.files.has(name)) {
        console.warn(`Файл "${name}" вже доданий до архіву. Ігнорується.`);
        return;
      }
      if (name.endsWith('/')) {
        console.warn(`Ім'я файлу "${name}" схоже на директорію (закінчується на '/'). Використовуйте addFolder для директорій.`);
        name = name.slice(0, -1); // Видалити слеш для файлу
    }

      const utf8Encoder = new TextEncoder();
      const encodedName = utf8Encoder.encode(name);
      let storedContent;
      let crc32 = null; // Буде null для Blob
      let size = 0;

      // --- ПОКРАЩЕННЯ: Обробка lastModified ---
      const lastModified = options.lastModified instanceof Date ? options.lastModified : new Date();
      const dosDateTime = dateToDos(lastModified);

      if (content instanceof Blob) {
        storedContent = content;
        size = content.size;
        // CRC32 буде обчислено пізніше для Blob
      } else if (typeof content === "string") {
        storedContent = utf8Encoder.encode(content);
        size = storedContent.length;
        crc32 = BrowserZip.computeCRC32(storedContent); // Синхронно для даних в пам'яті
      } else if (content instanceof Uint8Array) {
        storedContent = content;
        size = content.length;
        crc32 = BrowserZip.computeCRC32(storedContent); // Синхронно для даних в пам'яті
      } else {
        throw new Error("Непідтримуваний тип контенту. Має бути Blob, string, або Uint8Array.");
      }
      
      const fileRecord = {
        name,
        encodedName,
        content: storedContent,
        crc32, // null для Blob
        size, // Розмір відомий одразу
        isDirectory: false,
        dosTime: dosDateTime.dosTime,
        dosDate: dosDateTime.dosDate,
        localHeaderOffset: -1 // Буде встановлено під час генерації
      };

      this.files.set(name, fileRecord);
    }

    /**
     * Додає папку до архіву.
     * @param {string} folderName – Ім'я папки (наприклад, "folder/").
     * @param {object} [options] - Додаткові опції.
     * @param {Date} [options.lastModified=new Date()] - Час останньої модифікації.
     */
    async addFolder(folderName, options = {}) {
      if (!folderName.endsWith("/")) {
        folderName += "/";
      }
      if (this.files.has(folderName)) {
        console.warn(`Папка "${folderName}" вже додана до архіву. Ігнорується.`);
        return;
      }

      // Обробка lastModified
      const lastModified = options.lastModified instanceof Date ? options.lastModified : new Date();
      const dosDateTime = dateToDos(lastModified);

      const utf8Encoder = new TextEncoder();
      const encodedName = utf8Encoder.encode(folderName);
      // Директорія не має вмісту, розмір = 0, CRC = 0.
      const fileRecord = {
        name: folderName,
        encodedName,
        content: new Uint8Array(0), // Немає контенту
        crc32: 0,                  // CRC32 = 0 для директорії
        size: 0,                   // Розмір = 0 для директорії
        isDirectory: true,
        dosTime: dosDateTime.dosTime,
        dosDate: dosDateTime.dosDate,
        localHeaderOffset: -1 // Буде встановлено під час генерації
      };
      this.files.set(folderName, fileRecord);
    }

    /**
     * Створює локальний заголовок файлу у форматі ZIP з підтримкою Zip64.
     * @param {Object} fileRecord.name – ім'я.
     * @param {Uint8Array} fileRecord.encodedName – закодоване ім'я файлу.
     * @param {Uint8Array} fileRecord.content – вміст файлу.
     * @param {number} fileRecord.crc32 – обчислений CRC32.
     * @param {number} fileRecord.size – розмір файлу.
     * @param {number} fileRecord.isDirectory - true, якщо це директорія.
     * @param {number} fileRecord.dosTime - dosDateTime.dosTime,
     * @param {number} fileRecord.dosDate - dosDateTime.dosDate,
     * @param {number} fileRecord.localHeaderOffset - зміщення заголовка.
     * @returns {Uint8Array} – локальний заголовок файлу.
     */
    createLocalFileHeader(fileRecord) {
      const { encodedName, size, crc32, dosTime, dosDate } = fileRecord;
      const useZip64 = size >= 0xFFFFFFFF;
            // Поле Zip64 для локального заголовку містить тільки розміри
      const extraFieldSize = useZip64 ? (4 + ZIP64_EXTRA_FIELD_SIZE_NO_OFFSET) : 0; // ID(2) + Size(2) + Sizes(16)
      const headerSize = 30 + encodedName.length + extraFieldSize;
      const header = new Uint8Array(headerSize);
      const view = new DataView(header.buffer);
    
      view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
      view.setUint16(4, useZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFAULT, true);
      view.setUint16(6, FLAG_UTF8, true); // Загальний прапорець (Bit 3: data descriptor, Bit 11: UTF-8)
      // Якщо CRC/розмір невідомі на момент запису заголовку,
      // встановлюється Bit 3 і ці поля заповнюються нулями,
      // а реальні значення записуються в Data Descriptor *після* даних файлу.
      // Наша поточна реалізація обчислює CRC/розмір *до* запису LFH,
      // тому Bit 3 не встановлюємо.
      view.setUint16(8, METHOD_STORE, true);
      view.setUint16(10, dosTime, true);            // Час модифікації
      view.setUint16(12, dosDate, true);            // Дата модифікації
      view.setUint32(14, crc32 || 0, true);         // CRC-32 (0 якщо ще невідомий і використовується data descriptor)
      const sizeField = useZip64 ? 0xFFFFFFFF : size;
      view.setUint32(18, sizeField, true);          // Стиснутий розмір
      view.setUint32(22, sizeField, true);          // Нестиснутий розмір
      view.setUint16(26, encodedName.length, true); // Довжина імені файлу
      view.setUint16(28, extraFieldSize, true);     // Довжина додаткового поля
      header.set(encodedName, 30);
    
      if (useZip64) {
        let pos = 30 + encodedName.length;
        // Запис Zip64 extra field: ID (0x0001), довжина (16 байт),
        // 64-бітний нестиснутий розмір, 64-бітний стиснутий розмір.
        view.setUint16(pos, ZIP64_EXTRA_FIELD_ID, true); pos += 2;
        view.setUint16(pos, ZIP64_EXTRA_FIELD_SIZE_NO_OFFSET, true); pos += 2;
        view.setBigUint64(pos, BigInt(size), true); pos += 8; // Нестиснутий розмір
        view.setBigUint64(pos, BigInt(size), true); pos += 8; // Стиснутий розмір
      }
      return header;
    }

    /**
     * Створює запис центрального каталогу для файлу з підтримкою Zip64.
     * Для директорій зовнішній атрибут встановлюється так, щоб відзначати об'єкт як папку (наприклад, 0x10 << 16).
     * @param {Object} fileRecord.name – ім'я.
     * @param {Uint8Array} fileRecord.encodedName – закодоване ім'я файлу.
     * @param {Uint8Array} fileRecord.content – вміст файлу.
     * @param {number} fileRecord.crc32 – обчислений CRC32.
     * @param {number} fileRecord.size – розмір файлу.
     * @param {number} fileRecord.isDirectory - true, якщо це директорія.
     * @param {number} fileRecord.dosTime - dosDateTime.dosTime,
     * @param {number} fileRecord.dosDate - dosDateTime.dosDate,
     * @param {number} fileRecord.localHeaderOffset - зміщення заголовка.
     * @returns {Uint8Array} – запис центрального каталогу.
     */
    createCentralDirectoryHeader(fileRecord) {
      const { encodedName, size, crc32, dosTime, dosDate, isDirectory, localHeaderOffset } = fileRecord;
      const useZip64 = size >= 0xFFFFFFFF || localHeaderOffset >= 0xFFFFFFFF;
       // Поле Zip64 для центрального каталогу може містити розміри та зміщення
       let zip64ExtraFieldSize = 0;
       let zip64Data = []; // Масив байт для даних Zip64
 
       const needsSizeZip64 = size >= 0xFFFFFFFF;
       const needsOffsetZip64 = localHeaderOffset >= 0xFFFFFFFF;
 
       if (needsSizeZip64) {
            zip64Data.push(...new Array(16).fill(0)); // Місце для 2 x 64-біт розмірів
            const sizeView = new DataView(new ArrayBuffer(16));
            sizeView.setBigUint64(0, BigInt(size), true); // Original size
            sizeView.setBigUint64(8, BigInt(size), true); // Compressed size
            zip64Data.splice(0, 16, ...new Uint8Array(sizeView.buffer));
       }
        if (needsOffsetZip64) {
            const offsetBytes = new Array(8).fill(0);
            const offsetView = new DataView(new ArrayBuffer(8));
            offsetView.setBigUint64(0, BigInt(localHeaderOffset), true);
            zip64Data.push(...new Uint8Array(offsetView.buffer));
        }
       // Можливо, додати Disk Start Number (зазвичай 0)
       // let needsDiskNumberZip64 = false; // Якщо підтримуємо багатодискові архіви
       // if (needsDiskNumberZip64) zip64Data.push(0,0,0,0);
 
 
       if (zip64Data.length > 0) {
            zip64ExtraFieldSize = 4 + zip64Data.length; // ID(2) + Size(2) + Data
       }
 
 
       const headerSize = 46 + encodedName.length + zip64ExtraFieldSize;
       const header = new Uint8Array(headerSize);
       const view = new DataView(header.buffer);
 
       view.setUint32(0, CENTRAL_DIR_SIGNATURE, true);
       view.setUint16(4, useZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFAULT, true); // Version made by
       view.setUint16(6, useZip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED_DEFAULT, true); // Version needed
       view.setUint16(8, FLAG_UTF8, true);
       view.setUint16(10, METHOD_STORE, true);
       view.setUint16(12, dosTime, true); // Time
       view.setUint16(14, dosDate, true); // Date
       view.setUint32(16, crc32 || 0, true);
       const sizeField = needsSizeZip64 ? 0xFFFFFFFF : size;
       view.setUint32(20, sizeField, true); // Compressed size
       view.setUint32(24, sizeField, true); // Uncompressed size
       view.setUint16(28, encodedName.length, true);
       view.setUint16(30, zip64ExtraFieldSize, true); // Extra field length
       view.setUint16(32, 0x0000, true); // File comment length
       view.setUint16(34, 0x0000, true); // Disk number start
       view.setUint16(36, 0x0000, true); // Internal file attributes
       // External file attributes: MS-DOS directory bit
       view.setUint32(38, isDirectory ? (MSDOS_DIR_ATTR << 16) : 0x00000000, true);
       const offsetField = needsOffsetZip64 ? 0xFFFFFFFF : localHeaderOffset;
       view.setUint32(42, offsetField, true); // Relative offset of local header
       header.set(encodedName, 46);
 
       if (zip64ExtraFieldSize > 0) {
         let pos = 46 + encodedName.length;
         view.setUint16(pos, ZIP64_EXTRA_FIELD_ID, true); pos += 2;
         view.setUint16(pos, zip64Data.length, true); pos += 2; // Size of data part
         header.set(new Uint8Array(zip64Data), pos); // Записуємо підготовлені дані
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

      const eocdBuffer = new ArrayBuffer(22);
      const viewEOCD = new DataView(eocdBuffer);
      viewEOCD.setUint32(0, END_OF_CENTRAL_DIR_SIGNATURE, true);
      viewEOCD.setUint16(4, 0, true); // Disk number
      viewEOCD.setUint16(6, 0, true); // Disk where CD starts
      viewEOCD.setUint16(8, useZip64 ? 0xFFFF : totalEntries, true); // Entries on this disk
      viewEOCD.setUint16(10, useZip64 ? 0xFFFF : totalEntries, true); // Total entries
      viewEOCD.setUint32(12, useZip64 ? 0xFFFFFFFF : centralDirectorySize, true); // CD size
      viewEOCD.setUint32(16, useZip64 ? 0xFFFFFFFF : centralDirectoryOffset, true); // CD offset
      viewEOCD.setUint16(20, 0, true); // Comment length

      const eocd = new Uint8Array(eocdBuffer);

      if (useZip64) {
        // Zip64 EOCD Record (56 bytes)
        const zip64EndBuffer = new ArrayBuffer(56);
        const viewZip64 = new DataView(zip64EndBuffer);
        viewZip64.setUint32(0, ZIP64_END_OF_CENTRAL_DIR_SIGNATURE, true);
        viewZip64.setBigUint64(4, 44n, true); // Size of record (following this field)
        viewZip64.setUint16(12, VERSION_NEEDED_ZIP64, true); // Version made by
        viewZip64.setUint16(14, VERSION_NEEDED_ZIP64, true); // Version needed to extract
        viewZip64.setUint32(16, 0, true); // This disk number
        viewZip64.setUint32(20, 0, true); // Disk where CD starts
        viewZip64.setBigUint64(24, BigInt(totalEntries), true); // Entries on this disk
        viewZip64.setBigUint64(32, BigInt(totalEntries), true); // Total entries
        viewZip64.setBigUint64(40, BigInt(centralDirectorySize), true); // CD size
        viewZip64.setBigUint64(48, BigInt(centralDirectoryOffset), true); // CD offset
        const zip64End = new Uint8Array(zip64EndBuffer);

        // Zip64 EOCD Locator (20 bytes)
        const zip64LocatorBuffer = new ArrayBuffer(20);
        const viewLocator = new DataView(zip64LocatorBuffer);
        viewLocator.setUint32(0, ZIP64_END_OF_CENTRAL_DIR_LOCATOR_SIGNATURE, true);
        viewLocator.setUint32(4, 0, true); // Disk with Zip64 EOCD Record
        // Offset of Zip64 EOCD Record (position *just before* this locator)
        viewLocator.setBigUint64(8, BigInt(centralDirectoryOffset + centralDirectorySize), true);
        viewLocator.setUint32(16, 1, true); // Total number of disks
        const zip64Locator = new Uint8Array(zip64LocatorBuffer);

        return [zip64End, zip64Locator, eocd]; // Порядок важливий: Zip64 EOCD, Zip64 Locator, EOCD
      } else {
        return [eocd];
      }
    }

    /**
     * Генерує ZIP‑архів як ReadableStream.
     * Потік формується шляхом послідовного додавання локальних заголовків, вмісту файлів,
     * записів центрального каталогу та кінцевих записів (EOCD та Zip64 EOCD, якщо потрібно).
     * @param {object} [options] - Опції генерації.
     * @param {number} [options.chunkSizeForCRC=1024 * 1024] – Розмір чанку для CRC32.
     * @param {function} [options.onProgress=null] – Функція зворотного виклику для оновлення прогресу
     *   (отримує об'єкт: { filename, fileBytesProcessed, fileTotalBytes, overallProgressPercent })
     * @param {boolean} [options.clearAfterGenerate=true] - Чи очищати список файлів після генерації.
     * @returns {ReadableStream} – Потік з даними ZIP‑архіву.
     */
    generateZipStream(options = {}) {
      const { chunkSizeForCRC = 1024 * 1024, onProgress = null, clearAfterGenerate = true } = options;
      const self = this;
      // Робимо копію, якщо не плануємо очищати, або працюємо з оригіналом
      const fileRecords = Array.from(this.files.values());
      const centralDirectoryEntries = [];
      let currentOffset = 0n; // --- ПОКРАЩЕННЯ: Використовуємо BigInt для зміщення ---
      let totalUncompressedSize = 0n;

      // Обчислюємо загальний розмір даних (для прогресу)
      for (const fileRecord of fileRecords) {
          totalUncompressedSize += BigInt(fileRecord.size);
      }

      const stream = new ReadableStream({
        async start(controller) { 
          try {
            let processedSize = 0n; // --- ПОКРАЩЕННЯ: BigInt для прогресу ---

            for (const fileRecord of fileRecords) {
              // Перевіряємо, чи CRC32 вже обчислено (для не-Blob)
              if (fileRecord.crc32 === null && fileRecord.content instanceof Blob) {
                  try {
                      fileRecord.crc32 = await self.workerPool.runCRC32Stream(fileRecord.content, chunkSizeForCRC);
                  } catch (error) {
                      console.error(`Помилка обчислення CRC32 для файлу "${fileRecord.name}":`, error);
                      throw new Error(`Помилка CRC32 для "${fileRecord.name}": ${error.message}`);
                  }
              } else if (fileRecord.isDirectory) {
                   fileRecord.crc32 = 0; // Переконуємося, що для директорії CRC = 0
              }

              // Зберігаємо зміщення *перед* записом локального заголовку
              fileRecord.localHeaderOffset = Number(currentOffset); // Зберігаємо як Number, перевірка на > 0xFFFFFFFF буде в CDH

              // Створюємо та надсилаємо локальний заголовок
              const localHeader = self.createLocalFileHeader(fileRecord);
              controller.enqueue(localHeader);
              currentOffset += BigInt(localHeader.byteLength);

              // Потокове надсилання вмісту файлу (якщо є)
              if (!fileRecord.isDirectory && fileRecord.size > 0) {
                let fileBytesProcessed = 0n;
                const fileSizeBigInt = BigInt(fileRecord.size);

                 // Оновлення прогресу перед початком обробки файлу
                 updateProgress(processedSize, fileRecord, 0n, fileSizeBigInt, onProgress);

                if (fileRecord.content instanceof Blob) {
                  const reader = fileRecord.content.stream().getReader();
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(value); // value це Uint8Array
                    const chunkLen = BigInt(value.byteLength);
                    currentOffset += chunkLen;
                    processedSize += chunkLen;
                    fileBytesProcessed += chunkLen;
                    // Оновлюємо прогрес після кожного чанку
                    updateProgress(processedSize, fileRecord, fileBytesProcessed, fileSizeBigInt, onProgress);
                  }
                } else if (fileRecord.content instanceof Uint8Array) {
                  controller.enqueue(fileRecord.content);
                  const chunkLen = BigInt(fileRecord.content.byteLength);
                  currentOffset += chunkLen;
                  processedSize += chunkLen;
                  fileBytesProcessed = chunkLen;
                  // Оновлюємо прогрес після запису всього вмісту
                  updateProgress(processedSize, fileRecord, fileBytesProcessed, fileSizeBigInt, onProgress);
                }
                 // Можливо, ще одне оновлення прогресу для файлу = 100%
                 // updateProgress(processedSize, fileRecord, fileSizeBigInt, fileSizeBigInt, onProgress);
              } else {
                   // Для порожніх файлів/директорій теж можна викликати прогрес (0/0 bytes)
                   updateProgress(processedSize, fileRecord, 0n, 0n, onProgress);
              }

              // Створюємо запис центрального каталогу (зміщення вже відоме)
              const centralHeader = self.createCentralDirectoryHeader(fileRecord);
              centralDirectoryEntries.push(centralHeader);
            } // end for loop (fileRecords)

            // Записуємо центральний каталог
            let centralDirSize = 0n;
            const centralDirOffset = currentOffset; // Зміщення початку CD

            for (const entry of centralDirectoryEntries) {
              controller.enqueue(entry);
              centralDirSize += BigInt(entry.byteLength);
            }
            currentOffset += centralDirSize;

            // Записуємо кінцеві записи
            const endRecords = self.createEndRecords(
                Number(centralDirOffset), // Конвертуємо BigInt в Number для EOCD записів
                Number(centralDirSize),   // (перевірка на > 0xFFFFFFFF вже виконана)
                fileRecords.length
            );
            for (const rec of endRecords) {
              controller.enqueue(rec);
              // currentOffset += BigInt(rec.byteLength); // Оновлення offset тут вже не потрібне
            }

            // --- ПОКРАЩЕННЯ: Опціональне очищення ---
            if (clearAfterGenerate) {
                self.files.clear();
            }

            controller.close(); // Завершуємо потік

          } catch (error) {
            console.error("Помилка під час генерації ZIP:", error);
            controller.error(error); // Передаємо помилку в потік
          }


          function updateProgress(processed, record, fileProcessed, fileTotal, callback) {
            if (!callback) return;
            let overallPercent = 0;
            // Запобігання діленню на нуль, якщо загальний розмір 0
            if (totalUncompressedSize > 0n) {
                // Обережно з великими числами при обчисленні відсотка
                overallPercent = Math.min(100, Math.round(Number(processed * 100n / totalUncompressedSize)));
            } else if (record) { // Якщо розмір 0, але є файли, показуємо 100% після останнього
                 overallPercent = 100;
            }
            callback({
              filename: record ? record.name : null, // Може бути null на початковому етапі
              fileBytesProcessed: Number(fileProcessed), // Конвертуємо в Number для колбеку
              fileTotalBytes: Number(fileTotal),       // Конвертуємо в Number для колбеку
              overallProgressPercent: overallPercent
            });
          }
        } // end start(controller)
      });
      return stream;
    }
    
    /**
     * Завантажує ZIP‑архів.
     * Генерується архів через ReadableStream, створюється Blob, генерується URL,
     * а потім симулюється клік для завантаження.
    * @param {string} fileName - Ім'я вихідного ZIP‑файлу (наприклад, "archive.zip").
    * @param {object} [generationOptions] - Опції, що передаються в `generateZipStream`.
    * @param {number} [generationOptions.chunkSizeForCRC=65536]
    * @param {function} [generationOptions.onProgress=null]
    */
    async downloadZip(fileName, generationOptions = {}) {
      try {
        const zipStream = this.generateZipStream(generationOptions);
        const response = new Response(zipStream, {
          headers: { 'Content-Type': 'application/zip' }
        });
        const zipBlob = await response.blob();
        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link); // Додавання в DOM може бути потрібним для деяких браузерів
        link.click();
        document.body.removeChild(link); // Прибираємо за собою
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error(`Не вдалося завантажити ZIP "${fileName}":`, error);
        // Повідомити користувача про помилку
        alert(`Помилка завантаження архіву: ${error.message}`);
        // Якщо потік був створений, але сталася помилка, спробувати його скасувати
        if (zipStream && zipStream.locked === false) {
            zipStream.cancel(error).catch(() => {}); // Ігноруємо помилку скасування
        }
        // Важливо: Не очищати this.files, якщо clearAfterGenerate=false і сталася помилка,
        // щоб користувач міг спробувати знову.
        // Якщо clearAfterGenerate=true, файли вже могли бути очищені в generateZipStream.
      }
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
