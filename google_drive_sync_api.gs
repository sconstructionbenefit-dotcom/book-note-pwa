/**
 * 読書ノート to note | Googleドライブ同期Web API (Google Apps Script)
 * 
 * 【設定手順】
 * 1. Googleドライブ (https://drive.google.com/) を開きます。
 * 2. 左上の「＋ 新規」＞「その他」＞「Google Apps Script」をクリック。
 * 3. 本コードをコードエディタにすべて貼り付けます。
 * 4. 右上の「デプロイ」＞「新しいデプロイ」をクリック。
 * 5. 種類の選択（歯車アイコン）で「ウェブアプリ」を選択。
 *    - 次のユーザーとして実行: 「自分」
 *    - アクセスできるユーザー: 「全員」
 * 6. 「デプロイ」をクリックし、表示された「ウェブアプリのURL」をコピーします。
 * 7. PWA（スマホおよびPC）の「⚙️設定」＞「Googleドライブ同期設定」にそのURLを貼り付ければ完了です！
 */

const SYNC_FOLDER_NAME = "読書ノート_PWA同期";
const SYNC_FILE_NAME = "reading_notes_sync.json";

function getOrCreateSyncFolder() {
  const folders = DriveApp.getFoldersByName(SYNC_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(SYNC_FOLDER_NAME);
}

function getOrCreateSyncFile() {
  const folder = getOrCreateSyncFolder();
  const files = folder.getFilesByName(SYNC_FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  const initialData = JSON.stringify({
    lastSyncTime: new Date().toISOString(),
    books: [],
    memos: []
  });
  return folder.createFile(SYNC_FILE_NAME, initialData, MimeType.PLAIN_TEXT);
}

// データ取得 (GET)
function doGet(e) {
  try {
    const file = getOrCreateSyncFile();
    const content = file.getBlob().getDataAsString("UTF-8");
    
    return ContentService.createTextOutput(content)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const errObj = { error: true, message: err.toString() };
    return ContentService.createTextOutput(JSON.stringify(errObj))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// データ保存・同期 (POST)
function doPost(e) {
  try {
    let payload = null;
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else {
      throw new Error("No post data received");
    }

    const file = getOrCreateSyncFile();
    
    // 既存データとマージ
    let currentData = { books: [], memos: [] };
    try {
      const existing = file.getBlob().getDataAsString("UTF-8");
      if (existing) {
        currentData = JSON.parse(existing);
      }
    } catch (e) {}

    // マージ処理 (最新日時優先)
    const mergedBooksMap = new Map();
    (currentData.books || []).forEach(b => mergedBooksMap.set(b.id, b));
    (payload.books || []).forEach(b => {
      const existing = mergedBooksMap.get(b.id);
      if (!existing || !existing.updatedAt || (b.updatedAt && new Date(b.updatedAt) >= new Date(existing.updatedAt))) {
        mergedBooksMap.set(b.id, b);
      }
    });

    const mergedMemosMap = new Map();
    (currentData.memos || []).forEach(m => mergedMemosMap.set(m.id, m));
    (payload.memos || []).forEach(m => {
      const existing = mergedMemosMap.get(m.id);
      if (!existing || !existing.updatedAt || (m.updatedAt && new Date(m.updatedAt) >= new Date(existing.updatedAt))) {
        mergedMemosMap.set(m.id, m);
      }
    });

    const finalData = {
      lastSyncTime: new Date().toISOString(),
      books: Array.from(mergedBooksMap.values()),
      memos: Array.from(mergedMemosMap.values())
    };

    file.setContent(JSON.stringify(finalData, null, 2));

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      data: finalData
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const errObj = { success: false, error: err.toString() };
    return ContentService.createTextOutput(JSON.stringify(errObj))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
