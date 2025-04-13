// Робота з інтерфейсом
const fileInput = document.getElementById("fileInput");
const zipButton = document.getElementById("zipButton");
const mainContainer = document.getElementById('mainContainer');


zipButton.addEventListener("click", async () => {
  const zip = new BrowserZip();

  const files = fileInput.files;
  if (files.length === 0) {
    appendAlert("Будь ласка, виберіть файли для архівування!", 'danger')
    return;
  }

  // Додаємо файли до архіву
  for (const file of files)
    await zip.addFile(file.name, file);


  // Генеруємо ZIP-архів
  zip.downloadZipStream("archive.zip");

  // Показуємо статус успішного завершення
  appendAlert('Архів створено та завантажено успішно!', 'success')
});



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

/*
{
  const zip = new BrowserZip();

  async function createZip() {
    await zip.addFile("example.txt", "Текстовий вміст файлу");
    const blob = new Blob(["Це вміст BLOB-файлу"], { type: "text/plain" });
    await zip.addFile("blobFile.txt", blob);

    zip.downloadZipStream("myArchive.zip");
  }

  createZip();

}
*/