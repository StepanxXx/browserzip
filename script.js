// Робота з інтерфейсом
const fileInput = document.getElementById("fileInput");
const zipButton = document.getElementById("zipButton");
const mainContainer = document.getElementById('mainContainer');
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");

zipButton.addEventListener("click", async () => {
  const zip = new BrowserZip();

  const files = fileInput.files;
  if (files.length === 0) {
    appendAlert("Будь ласка, виберіть файли для архівування!", 'danger');
    return;
  }

  // Показуємо прогрес-бар
  progressContainer.classList.remove("invisible");
  progressBar.style.width = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
  progressBar.textContent = "0%";

  // Додаємо файли до архіву
  for (const file of files) {
    await zip.addFile(file.name, file);
  }

  // Генеруємо ZIP-архів із прогресом
  await zip.downloadZip("archive.zip", 65536, (progress) => {
    progressBar.style.width = `${progress}%`;
    progressBar.setAttribute("aria-valuenow", progress);
    progressBar.textContent = `${progress}%`;
  });

  zip.terminate();

  // Ховаємо прогрес-бар після завершення
  setTimeout(() => {
    progressContainer.classList.add("invisible");
  }, 2000);

  appendAlert('Архів створено та завантажено успішно!', 'success')
});;



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