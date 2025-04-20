// Робота з інтерфейсом
const fileInput = document.getElementById("fileInput");
const zipButton = document.getElementById("zipButton");
const mainContainer = document.getElementById('mainContainer');
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById('progressLabel'); // Елемент для тексту

zipButton.addEventListener("click", async () => {
  const zip = new BrowserZip();

  const files = fileInput.files;
  if (files.length === 0) {
    appendAlert("Будь ласка, виберіть файли для архівування!", 'danger');
    return;
  }

  // Показуємо прогрес-бар
  progressBar.style.width = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
  progressBar.textContent = "0%";
  progressContainer.classList.remove("invisible");

  // Додаємо файли до архіву
  for (const file of files) {
    await zip.addFile(file.name, file);
  }

  // Генеруємо ZIP-архів із прогресом
  await zip.downloadZip("archive.zip", { onProgress: updateProgress })

  zip.terminate();

  // Ховаємо прогрес-бар після завершення
  setTimeout(() => {
    progressContainer.classList.add("invisible");
    progressLabel.textContent = "";
  }, 2000);

  appendAlert('Архів створено та завантажено успішно!', 'success')
});

const updateProgress = ({ filename, overallProgressPercent, fileBytesProcessed, fileTotalBytes }) => {
  try {
    if (!progressBar) return;
    progressBar.style.width = `${overallProgressPercent.toFixed(1)}%`;
    progressBar.setAttribute("aria-valuenow", overallProgressPercent.toFixed(1));
    progressBar.textContent = `${overallProgressPercent.toFixed(1)}%`;
    if (!progressLabel) return;
    if (filename) {
      let label = ` | File: ${filename}`;
      if (fileBytesProcessed && fileTotalBytes) {
        label += ` (${((fileBytesProcessed / fileTotalBytes) * 100).toFixed(0)}%)`;
      }
      progressLabel.textContent = label;
    }
  } catch (error) {
    console.error("Error updating progress:", error);
  }
};

const appendAlert = (message, type) => {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = [
    `<div class="alert alert-${type} alert-dismissible fade show" role="alert" style="margin: 16px 0;">`,
    `   <div>${message}</div>`,
    '   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
    '</div>'
  ].join('')

  mainContainer.append(wrapper)
}

/*test
{
  const zip = new BrowserZip();

  async function createZip() {
    await zip.addFile("example.txt", "Текстовий вміст файлу");
    const blob = new Blob(["Це вміст BLOB-файлу"], { type: "text/plain" });
    await zip.addFile("blobFile.txt", blob);

    zip.downloadZip("myArchive.zip");
  }

  createZip();

}
*/



(async () => {
  const zip = new BrowserZip();
  const fileContent = new Blob(["Це великий файл для тестування CRC32 у воркері...".repeat(10000)]);
  const smallText = "Простий текстовий файл.";

  await zip.addFile("example.txt", smallText, { lastModified: new Date(2023, 10, 20, 10, 30, 0) });
  await zip.addFolder("data/", { lastModified: new Date(2023, 10, 19) });
  await zip.addFile("data/large_file.bin", fileContent); // Використає поточний час

  console.log("Починаємо генерацію архіву...");

  await zip.downloadZip("my_archive.zip", {
    chunkSizeForCRC: 512 * 1024, // 512 KB чанк для CRC
    onProgress: (progress) => {
      console.log(`Прогрес: ${progress.overallProgressPercent}% ` +
                  `(Файл: ${progress.filename || 'N/A'}, ${progress.fileBytesProcessed} / ${progress.fileTotalBytes} байт)`);
    },
    clearAfterGenerate: true // Очистити файли після генерації
  });

  console.log("Архів згенеровано та завантажено (або сталася помилка).");

  // Перевірка, чи файли очищено
  // console.log("Кількість файлів після генерації:", zip.files.size); // Має бути 0

  zip.terminate(); // Завершуємо роботу воркерів
})();