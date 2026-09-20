/**
 * 読書ノート to note | アイデア集積PWA
 * Core Application Logic (IndexedDB, Gemini API, Web Speech API, UI State)
 */

// ==========================================================================
// 1. IndexedDB Database Helper
// ==========================================================================
class BookNoteDB {
  constructor() {
    this.dbName = 'BookNoteToNoteDB';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('memos')) {
          const memoStore = db.createObjectStore('memos', { keyPath: 'id' });
          memoStore.createIndex('bookId', 'bookId', { unique: false });
          memoStore.createIndex('sectionId', 'sectionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => reject(e);
    });
  }

  async getAllBooks() {
    return this.getAll('books');
  }

  async getBook(id) {
    return this.get('books', id);
  }

  async saveBook(book) {
    return this.put('books', book);
  }

  async deleteBook(id) {
    await this.delete('books', id);
    // Cascade delete memos
    const memos = await this.getMemosByBook(id);
    for (const m of memos) {
      await this.delete('memos', m.id);
    }
  }

  async getAllMemos() {
    return this.getAll('memos');
  }

  async getMemosByBook(bookId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('memos', 'readonly');
      const store = tx.objectStore('memos');
      const index = store.index('bookId');
      const req = index.getAll(bookId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveMemo(memo) {
    return this.put('memos', memo);
  }

  async deleteMemo(id) {
    return this.delete('memos', id);
  }

  async getSetting(key, defaultValue = null) {
    const res = await this.get('settings', key);
    return res ? res.value : defaultValue;
  }

  async saveSetting(key, value) {
    return this.put('settings', { key, value });
  }

  // Generic DB Operations
  get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  put(storeName, item) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

// ==========================================================================
// 2. Gemini API Service
// ==========================================================================
class GeminiService {
  constructor(apiKey = '', model = 'gemini-3.6-flash') {
    this.apiKey = apiKey;
    this.model = model;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  setModel(model) {
    this.model = model;
  }

  hasApiKey() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 10);
  }

  async callGemini(prompt, images = [], isJson = false, retryCount = 0, currentModel = null) {
    if (!this.hasApiKey()) {
      throw new Error('Gemini APIキーが設定されていません。画面右上の⚙️設定から無料のAPIキーを入力してください。');
    }

    const modelToUse = currentModel || this.model || 'gemini-3.6-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${this.apiKey.trim()}`;

    const parts = [];

    // Add Images if provided (support both inline_data and direct properties)
    for (const img of images) {
      const data = img.inline_data?.data || img.inlineData?.data || img.base64 || img.data;
      const mimeType = img.inline_data?.mime_type || img.inlineData?.mimeType || img.mimeType || 'image/jpeg';
      if (data) {
        parts.push({
          inline_data: {
            mime_type: mimeType,
            data: data
          }
        });
      }
    }

    // Add Prompt text
    parts.push({ text: prompt });

    const genConfig = {
      temperature: 0.1,
      maxOutputTokens: 8192,
    };
    if (isJson) {
      genConfig.responseMimeType = "application/json";
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: genConfig
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = `Gemini API エラー (${response.status})`;
        try {
          const errObj = JSON.parse(errText);
          if (errObj.error?.message) {
            errMsg += `: ${errObj.error.message}`;
          }
        } catch (e) {
          errMsg += `: ${errText.slice(0, 100)}`;
        }

        // Automatic retry with exponential backoff on 503 (high demand) or 429 (rate limit)
        if ((response.status === 503 || response.status === 429) && retryCount < 2) {
          console.warn(`Gemini temporary error (${response.status}) on ${modelToUse}. Retrying in ${(retryCount + 1) * 1.5}s... (attempt ${retryCount + 1})`);
          await new Promise(r => setTimeout(r, (retryCount + 1) * 1500));
          return this.callGemini(prompt, images, isJson, retryCount + 1, modelToUse);
        }

        // Automatic fallback to official recommended gemini-3.6-flash if model is unrecognized or no longer available
        if (modelToUse !== 'gemini-3.6-flash' && (response.status === 503 || response.status === 404 || response.status === 400)) {
          console.warn(`Model ${modelToUse} failed with ${response.status}. Automatically falling back to official recommended gemini-3.6-flash...`);
          return this.callGemini(prompt, images, isJson, 0, 'gemini-3.6-flash');
        }

        throw new Error(errMsg);
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      // Network/Fetch level fallback
      if (modelToUse !== 'gemini-3.6-flash' && retryCount === 0 && !err.message.includes('APIキー')) {
        console.warn(`Network error on ${modelToUse}, trying gemini-3.6-flash fallback:`, err);
        return this.callGemini(prompt, images, isJson, 1, 'gemini-3.6-flash');
      }
      throw err;
    }
  }

  /**
   * 表紙および背後（裏表紙・奥付・帯）画像から書籍メタデータを自動抽出
   */
  async extractBookMetadata(images = []) {
    const prompt = `
あなたは書籍の書誌情報および装丁テキストを正確に解析するプロフェッショナルです。
提供された画像（表紙、裏表紙、背後、帯、奥付など）を読み取り、書籍に関する以下の情報を正確に抽出して純粋なJSONオブジェクトのみを出力してください。
説明文や前置き、Markdownのコードブロックは含めないでください。

【出力フォーマット】
{
  "title": "書籍タイトル（サブタイトルがある場合は『メインタイトル：サブタイトル』形式）",
  "author": "著者名（編著者、訳者、監修等を含む）",
  "publishedDate": "出版年月（例: 2024年3月、2023年等。奥付や発行日、著作権表記から判別）",
  "publisher": "出版社名（例: 技報堂出版、日経BP、学芸出版社等）",
  "theme": "書籍のテーマ・ジャンル（例: 建築・施工管理、不動産投資、資産運用、子育て・仕事術、思考法など適切なもの1つ）",
  "description": "裏表紙や帯、カバー袖に記載された本の内容紹介、キャッチコピー、あらすじ、推薦文などの要約テキスト（2〜4文程度）"
}

【補足指示】
- 写真が1枚だけ（表紙のみ、または奥付のみ）の場合でも、読み取れる項目を最大限正確に抽出してください。
- 読み取れない項目は空文字 "" にしてください。
- 帯のキャッチコピーよりも、書籍自体の正式なタイトル・著者を優先してください。
`;

    const resultText = await this.callGemini(prompt, images, true);
    
    return this.safeParseJSON(resultText, false);
  }
  /**
   * AIの出力から確実にJSONを抽出・修復してパースする堅牢パーサー
   */
  safeParseJSON(text, isArray = true) {
    if (!text || typeof text !== 'string') {
      return isArray ? [] : {};
    }

    // 1. コードブロック記法と前後の空白の除去
    let cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

    // 2. 境界（[ ... ] または { ... }）の厳密な抽出
    const startChar = isArray ? '[' : '{';
    const endChar = isArray ? ']' : '}';
    const firstIdx = cleaned.indexOf(startChar);
    const lastIdx = cleaned.lastIndexOf(endChar);

    if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
      cleaned = cleaned.substring(firstIdx, lastIdx + 1);
    }

    // 3. 末尾カンマの自動除去 (,\s*] や ,\s*})
    cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

    // 4. 初回パース試行
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      console.warn('First JSON.parse attempt failed, attempting aggressive repair:', err);
    }

    // 5. 積極的なクレンジング（文字列内の未エスケープ改行などの補正）
    try {
      const repaired = cleaned.replace(/(?<=:\s*"[^"]*)\r?\n(?=[^"]*")/g, '\\n');
      return JSON.parse(repaired);
    } catch (err2) {
      console.warn('Aggressive JSON repair failed:', err2);
    }

    // 6. 配列形式の目次であれば、テキスト行から章・節ツリーを自動復元する
    if (isArray) {
      return this.heuristicParseTOCText(text);
    }

    // オブジェクト形式で失敗した場合は、キー抽出による手動復元
    const titleMatch = text.match(/"title":\s*"([^"]+)"/);
    const authorMatch = text.match(/"author":\s*"([^"]+)"/);
    const pubMatch = text.match(/"publishedDate":\s*"([^"]+)"/);
    const puberMatch = text.match(/"publisher":\s*"([^"]+)"/);
    const themeMatch = text.match(/"theme":\s*"([^"]+)"/);
    const descMatch = text.match(/"description":\s*"([^"]+)"/);

    if (titleMatch || authorMatch || descMatch) {
      return {
        title: titleMatch ? titleMatch[1] : '不明な書籍',
        author: authorMatch ? authorMatch[1] : '',
        publishedDate: pubMatch ? pubMatch[1] : '',
        publisher: puberMatch ? puberMatch[1] : '',
        theme: themeMatch ? themeMatch[1] : '',
        description: descMatch ? descMatch[1] : ''
      };
    }

    throw new Error('AIが返したデータをJSONとして解読できませんでした。');
  }

  /**
   * JSONパースに失敗した場合でも、生テキストから章・節ツリーを自動復元する救済パーサー
   */
  heuristicParseTOCText(rawText) {
    console.log('Running heuristicParseTOCText fallback on raw AI output...');
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const chapters = [];
    let currentCh = null;
    let chIdx = 1;
    let secIdx = 1;

    for (const line of lines) {
      if (line === '[' || line === ']' || line === '{' || line === '}' || line.startsWith('"sections"') || line.startsWith('"id"')) continue;

      let text = line;
      const titleMatch = line.match(/"(?:chapterTitle|title|sectionTitle)":\s*"([^"]+)"/);
      if (titleMatch) {
        text = titleMatch[1];
      } else {
        text = line.replace(/^["'・\-\*\d\.\s]+/, '').replace(/["',]+$/, '').trim();
      }

      if (!text || text.length < 2) continue;

      if (text.startsWith('第') || text.includes('章') || text.startsWith('Chapter') || text.includes('はじめに') || text.includes('おわりに') || text.includes('プロローグ') || text.includes('エピローグ') || !currentCh) {
        currentCh = {
          id: `c_${chIdx}`,
          chapterNumber: text.match(/^第[\d一二三四五六七八九十]+章/)?.[0] || `第${chIdx}章`,
          chapterTitle: text,
          sections: []
        };
        chapters.push(currentCh);
        chIdx++;
        secIdx = 1;
      } else {
        if (currentCh) {
          currentCh.sections.push({
            id: `s_${chIdx - 1}_${secIdx}`,
            sectionNumber: `${chIdx - 1}-${secIdx}`,
            sectionTitle: text
          });
          secIdx++;
        }
      }
    }

    if (chapters.length > 0) {
      return chapters;
    }

    return [
      {
        id: 'c1',
        chapterNumber: '第1章',
        chapterTitle: '読み取った目次',
        sections: [
          { id: 's1_1', sectionNumber: '1-1', sectionTitle: '目次内容' }
        ]
      }
    ];
  }

  /**
   * 目次画像（1〜複数ページ）またはテキストから章・節ツリーJSONを自動生成
   * 複数ページに及ぶ場合も、ページ順を考慮して1つの連続したツリーに自動結合
   */
  async parseTOC(images = [], rawText = '') {
    const isMultiPage = images.length > 1;
    const prompt = `
あなたは書籍の目次構造を高精度に解析する専門AIです。
提供された${images.length}枚の目次画像${isMultiPage ? '（複数ページにわたる連続した目次写真群）' : ''}または手動入力テキストから、書籍全体の目次構造（章・節・項・コラム・事例）を漏れなく完全に抽出・階層化し、必ず以下のJSON配列形式のみを出力してください。
Markdownのバッククォート（\`\`\`json等）や前置き、解説文は一切含めず、純粋なJSON文字列のみを返してください。

【出力JSONスキーマ】
[
  {
    "id": "c1",
    "chapterNumber": "章番号（例: 序章、第1章、第2章、または章番号がなければ空文字\"\"）",
    "chapterTitle": "章の大見出しタイトル（書籍に書かれている実際の完全なタイトル文字列）",
    "sections": [
      {
        "id": "s1_1",
        "sectionNumber": "節番号（例: 1-1、①、Case 1、または番号がなければ空文字\"\"）",
        "sectionTitle": "節・項・小見出しのタイトル（書籍に書かれている実際の文字列）"
      }
    ]
  }
]

【重要解析ルール（最優先厳守事項）】
1. 【画像の向きの自動補正】: 写真が上下逆さま（180度倒立）や90度横向きになっている場合でも、AIの視覚認識により文字の向きを自動的に判断・補正して正確に読み取ってください。
2. 【見開き2ページの読書順】: 1枚の画像に見開き（左右2ページ）が写っている場合、書籍の形式（縦書きなら右ページから左ページ、横書きなら左ページから右ページ）に従って、正しい順序で章や節を抽出してください。
3. 【全章・全節の漏れなき完全抽出】:
   - 「巻頭」「はじめに」「序章」「第1章」〜「第N章」「COLUMN」「ケーススタディ」「おわりに」など、書籍に含まれるすべての章・区分を漏れなく大見出し（chapterTitle）として抽出してください。
   - 各章配下に存在するすべての小見出し、番号付き項目（1, 2, 3... / ①, ②, ③...）、箇条書き項目、実例ケースを漏れなく sections 配列に格納してください。
   - ダミー文字列（「章のタイトル」「節のタイトル」等）を出力することは固く禁止します。必ず写真内の文字を正確に転記してください。
${isMultiPage ? `
4. 【複数ページの自動マージ】:
   - 画像は Page 1 から順に並んでいます。
   - ページをまたいで章が続いている場合（前ページの終わりに始まった第2章が次ページにも続いている場合など）、章オブジェクトを重複して作成せず、同一の章の sections 配列に次ページの項目を連結してください。
` : ''}
5. 【不要記号のクレンジング】: ページ番号（ノンブル数字「…… 84」等）やドットリーダー記号（……、---）はタイトル文字列から除外してください。
6. 各要素の id にはユニークなID（c1, c2..., s1_1, s1_2...）を連番で付与してください。
${rawText ? `\n【手動入力テキスト】:\n${rawText}` : ''}
`;

    // 第3引数 isJson = true を指定して application/json を強制
    const resultText = await this.callGemini(prompt, images, true);
    return this.safeParseJSON(resultText, true);
  }

  /**
   * 吹き込んだ生メモから【要点】【本人の気づき】【note記事切り口】を自動構造化
   */
  async structureMemo(rawMemo, bookTitle, chapterContext) {
    const prompt = `
ユーザーは「雪国アーキパパ」という筆名でnoteを発信している一級建築士（32歳・準大手ゼネコン施工管理5年＋総合建設コンサル建築補償部5年、地方都市で築古アパート・戸建賃貸を経営、現在育休中・完全リモート）です。

書籍『${bookTitle}』の「${chapterContext}」を読書中に、以下のメモを記録しました。

【読書メモの生テキスト】:
"${rawMemo}"

この生メモから、note記事のアイデア集積に最適な以下の3つの要素を抽出・構造化してください。
必ず以下のJSON形式のみを出力してください（説明文やコードブロックは不要）。

{
  "summary": "書籍の内容・学んだ事実の簡潔な要約（1〜2文）",
  "insight": "一級建築士・施工管理・現場コスト感覚・不動産投資目線での独自の気づき・考察（1〜2文）",
  "noteAngle": "「雪国アーキパパ」としてnote記事に展開できるキャッチーな切り口・発信テーマ（例: 『なぜプロは〇〇を見落とすのか？現場監督が解説する〜』）"
}
`;

    const resultText = await this.callGemini(prompt, [], true);
    return this.safeParseJSON(resultText, false);
  }

  /**
   * 蓄積されたメモ群からnote記事の企画案・構成案を生成
   */
  async generateNotePlan(bookTitle, memos, tone) {
    const memoContext = memos.map((m, i) => {
      return `【メモ${i+1}】(章: ${m.chapterNumber} ${m.sectionTitle})\n・生メモ: ${m.text}\n・要点: ${m.summary || ''}\n・考察: ${m.insight || ''}\n・noteネタ切り口: ${m.noteAngle || ''}`;
    }).join('\n\n');

    const prompt = `
あなたはnoteの人気クリエイター「雪国アーキパパ」専属の編集者・企画構成ディレクターです。

【筆者プロファイル（雪国アーキパパ）】
- 32歳、一級建築士（国家資格）。
- 準大手ゼネコンで5年間施工管理（現場管理・コスト管理）→ 総合建設コンサルタント建築補償部で5年目（物件調査・算定積算）。
- 地方都市にて築古戸建・アパートを保有・再生中。現在育休中、完全リモートワークと家族の時間を最優先に資産形成。
- 文体・トーン: INFJ（誠実・論理的かつ読者に寄り添う温かみ。専門用語を噛み砕き、現場のリアルと失敗回避を伝える）。

書籍『${bookTitle}』から集積された以下の読書メモとアイデアをインプットに、note読者が引き込まれる実践的で魅力的な記事企画・構成案をMarkdown形式で作成してください。

【希望する切り口・トーン】: ${tone}

【集積されたメモデータ】:
${memoContext}

【出力フォーマット（Markdown）】
# 💡 note記事 企画・構成案

## ■ 記事タイトル案（3パターン）
1. （共感・問題提起型）
2. （実録・ノウハウ型）
3. （建築士・プロの現場視点型）

## ■ 企画概要とターゲット読者
- **想定ターゲット**: （どんな悩みを抱える読者か）
- **記事のゴール**: （読んだ後、読者が何を得られるか）
- **雪国アーキパパならではの独自バリュー**: （一級建築士×現場経験の強み）

## ■ 導入（リード文）の展開イメージ
（読者の共感を呼び、本文へ引き込むエピソードやフック）

## ■ 目次・見出し構成案（H2 / H3）
- ## 1. [見出し]
  - （ここで伝えるべきエピソード・要点）
- ## 2. [見出し]
  - （現場の実録・数字や失敗談の展開）
- ## 3. [見出し]
  - （一級建築士・プロとしてのチェックポイント）
- ## 4. まとめ：今日からできる一歩

## ■ 雪国アーキパパの執筆ワンポイントアドバイス
（文体、図解やスプレッドシートの活用アイデア、読後感のアドバイス）
`;

    return await this.callGemini(prompt);
  }
}

// ==========================================================================
// 3. Web Speech API (Voice Recognition Helper)
// ==========================================================================
class VoiceRecognitionHelper {
  constructor(onResultCallback, onStatusChangeCallback) {
    this.recognition = null;
    this.isRecording = false;
    this.onResult = onResultCallback;
    this.onStatusChange = onStatusChangeCallback;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.lang = 'ja-JP';
      this.recognition.continuous = true;
      this.recognition.interimResults = true;

      this.recognition.onstart = () => {
        this.isRecording = true;
        this.onStatusChange(true, '音声を聞き取り中... お話しください');
      };

      this.recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        this.onResult(transcript);
      };

      this.recognition.onerror = (event) => {
        console.warn('Speech recognition error:', event.error);
        this.isRecording = false;
        this.onStatusChange(false, '音声認識が停止しました');
      };

      this.recognition.onend = () => {
        this.isRecording = false;
        this.onStatusChange(false, 'タップして音声録音を開始');
      };
    }
  }

  isSupported() {
    return Boolean(this.recognition);
  }

  toggle() {
    if (!this.isSupported()) {
      alert('お使いのブラウザは音声認識に対応していません。テキストでご入力ください。');
      return;
    }

    if (this.isRecording) {
      this.recognition.stop();
    } else {
      try {
        this.recognition.start();
      } catch (err) {
        console.warn(err);
      }
    }
  }

  stop() {
    if (this.recognition && this.isRecording) {
      this.recognition.stop();
    }
  }
}

// ==========================================================================
// 4. Main Application Controller
// ==========================================================================
class AppController {
  constructor() {
    this.db = new BookNoteDB();
    this.gemini = new GeminiService();
    this.currentBook = null;
    this.currentSection = null;
    
    // Multi-Page TOC State
    this.pendingTOCPages = []; // Array of { id, dataUrl, base64, mimeType }
    this.parsedTOCData = null; // AI parsed structure waiting for confirmation

    // Book Cover / Back Photo State
    this.pendingCoverFront = null; // { dataUrl, base64, mimeType }
    this.pendingCoverBack = null;  // { dataUrl, base64, mimeType }

    this.voiceHelper = null;

    // UI Cache
    this.ui = {};
  }

  async init() {
    await this.db.init();
    this.cacheDomElements();
    this.setupEventListeners();
    await this.loadSettings();
    await this.initVoiceRecognition();
    await this.loadBooksAndSetCurrent();
    this.registerServiceWorker();
  }

  cacheDomElements() {
    this.ui = {
      // Navigation
      navItems: document.querySelectorAll('.bottom-nav .nav-item'),
      views: document.querySelectorAll('.app-view'),
      navBadgeCount: document.getElementById('nav-badge-count'),

      // Top bar & Book Select
      bookSelect: document.getElementById('current-book-select'),
      btnAddBook: document.getElementById('btn-add-book'),
      btnEditBook: document.getElementById('btn-edit-book'),
      btnQuickVoice: document.getElementById('btn-quick-voice'),
      btnSettings: document.getElementById('btn-settings'),

      // Book Hero
      heroTitle: document.getElementById('hero-title'),
      heroAuthor: document.getElementById('hero-author'),
      heroMemoCount: document.getElementById('hero-memo-count'),
      heroChapterCount: document.getElementById('hero-chapter-count'),
      heroCoverBadge: document.getElementById('hero-cover-badge'),
      heroCoverText: document.getElementById('hero-cover-text'),
      heroCoverImg: document.getElementById('hero-cover-img'),
      heroThemeBadge: document.getElementById('hero-theme-badge'),
      heroPublisherBadge: document.getElementById('hero-publisher-badge'),
      heroPublishedBadge: document.getElementById('hero-published-badge'),
      heroDescContainer: document.getElementById('hero-desc-container'),
      btnToggleHeroDesc: document.getElementById('btn-toggle-hero-desc'),
      heroDescText: document.getElementById('hero-desc-text'),
      btnImportTOC: document.getElementById('btn-import-toc'),
      btnHeroGenerateNote: document.getElementById('btn-hero-generate-note'),

      // TOC Tree Section
      tocTreeContainer: document.getElementById('toc-tree-container'),
      tocEmptyState: document.getElementById('toc-empty-state'),
      btnEmptyImportTOC: document.getElementById('btn-empty-import-toc'),
      btnExpandAll: document.getElementById('btn-expand-all'),
      btnCollapseAll: document.getElementById('btn-collapse-all'),

      // Memo Feed
      memoFeedContainer: document.getElementById('memo-feed-container'),
      memoFilterChips: document.querySelectorAll('.memo-filter-chips .chip-btn'),

      // Note Studio
      studioTargetScope: document.getElementById('studio-target-scope'),
      studioChapterSelectGroup: document.getElementById('studio-chapter-select-group'),
      studioChapterSelect: document.getElementById('studio-chapter-select'),
      studioToneSelect: document.getElementById('studio-tone-select'),
      btnGenerateNotePlan: document.getElementById('btn-generate-note-plan'),
      notePlanOutputContainer: document.getElementById('note-plan-output-container'),
      notePlanContent: document.getElementById('note-plan-content'),
      btnCopyPlanMd: document.getElementById('btn-copy-plan-md'),
      btnDownloadPlanMd: document.getElementById('btn-download-plan-md'),

      // Modals
      modalMemoSheet: document.getElementById('modal-memo-sheet'),
      btnCloseMemoSheet: document.getElementById('btn-close-memo-sheet'),
      memoSheetChapter: document.getElementById('memo-sheet-chapter'),
      memoSheetTitle: document.getElementById('memo-sheet-title'),
      btnRecordToggle: document.getElementById('btn-record-toggle'),
      voiceStatusText: document.getElementById('voice-status-text'),
      voiceWaveAnim: document.getElementById('voice-wave-anim'),
      inputMemoText: document.getElementById('input-memo-text'),
      btnSaveMemoAI: document.getElementById('btn-save-memo-ai'),
      btnSaveMemoRaw: document.getElementById('btn-save-memo-raw'),

      // TOC Import Modal (Multi-Page Upgraded)
      modalTOCImport: document.getElementById('modal-toc-import'),
      btnCloseTOCModal: document.getElementById('btn-close-toc-modal'),
      fileTOCCam: document.getElementById('file-toc-cam'),
      fileTOCLib: document.getElementById('file-toc-lib'),
      dropzoneTOC: document.getElementById('dropzone-toc'),
      btnDropzoneCam: document.getElementById('btn-dropzone-cam'),
      btnDropzoneLib: document.getElementById('btn-dropzone-lib'),
      btnAddTOCCam: document.getElementById('btn-add-toc-cam'),
      btnAddTOCLib: document.getElementById('btn-add-toc-lib'),
      btnClearTOCPages: document.getElementById('btn-clear-toc-pages'),
      tocPageBadge: document.getElementById('toc-page-badge'),
      tocPageListContainer: document.getElementById('toc-page-list-container'),
      tocParsedPreviewBox: document.getElementById('toc-parsed-preview-box'),
      tocParsedCount: document.getElementById('toc-parsed-count'),
      tocParsedList: document.getElementById('toc-parsed-list'),
      tocParseLoading: document.getElementById('toc-parse-loading'),
      tocLoadingText: document.getElementById('toc-loading-text'),
      manualTOCText: document.getElementById('manual-toc-text'),
      btnParseTOCAI: document.getElementById('btn-parse-toc-ai'),
      btnConfirmTOC: document.getElementById('btn-confirm-toc'),

      // Book Edit Modal (Cover & Back Dual Camera/Library Upgraded)
      modalBookEdit: document.getElementById('modal-book-edit'),
      bookModalTitle: document.getElementById('book-modal-title'),
      btnCloseBookModal: document.getElementById('btn-close-book-modal'),
      btnFrontCamera: document.getElementById('btn-front-camera'),
      btnFrontLibrary: document.getElementById('btn-front-library'),
      fileCoverFrontCam: document.getElementById('file-cover-front-cam'),
      fileCoverFrontLib: document.getElementById('file-cover-front-lib'),
      btnBackCamera: document.getElementById('btn-back-camera'),
      btnBackLibrary: document.getElementById('btn-back-library'),
      fileCoverBackCam: document.getElementById('file-cover-back-cam'),
      fileCoverBackLib: document.getElementById('file-cover-back-lib'),
      slotCoverFront: document.getElementById('slot-cover-front'),
      slotCoverBack: document.getElementById('slot-cover-back'),
      imgPreviewFront: document.getElementById('img-preview-front'),
      imgPreviewBack: document.getElementById('img-preview-back'),
      btnRemoveCoverFront: document.getElementById('btn-remove-cover-front'),
      btnRemoveCoverBack: document.getElementById('btn-remove-cover-back'),
      btnExtractBookAI: document.getElementById('btn-extract-book-ai'),
      bookExtractLoading: document.getElementById('book-extract-loading'),
      inputBookTitle: document.getElementById('input-book-title'),
      inputBookAuthor: document.getElementById('input-book-author'),
      inputBookPublished: document.getElementById('input-book-published'),
      inputBookPublisher: document.getElementById('input-book-publisher'),
      inputBookTheme: document.getElementById('input-book-theme'),
      inputBookDescription: document.getElementById('input-book-description'),
      btnSaveBook: document.getElementById('btn-save-book'),
      btnDeleteBook: document.getElementById('btn-delete-book'),

      // Settings Modal
      modalSettings: document.getElementById('modal-settings'),
      btnCloseSettingsModal: document.getElementById('btn-close-settings-modal'),
      inputGeminiKey: document.getElementById('input-gemini-key'),
      btnToggleKeyVisibility: document.getElementById('btn-toggle-key-visibility'),
      btnPasteApiKey: document.getElementById('btn-paste-api-key'),
      selectGeminiModel: document.getElementById('select-gemini-model'),
      btnSaveSettings: document.getElementById('btn-save-settings'),
      btnLoadSampleData: document.getElementById('btn-load-sample-data'),
      btnExportBackup: document.getElementById('btn-export-backup'),
      btnImportBackupTrigger: document.getElementById('btn-import-backup-trigger'),
      fileBackupInput: document.getElementById('file-backup-input'),

      // Toasts
      toastContainer: document.getElementById('toast-container'),
    };
  }

  setupEventListeners() {
    // Navigation Tabs
    this.ui.navItems.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetViewId = btn.getAttribute('data-view');
        this.switchView(targetViewId);
      });
    });

    // Book selection dropdown
    this.ui.bookSelect.addEventListener('change', async (e) => {
      await this.selectBook(e.target.value);
    });

    // Hero Description Toggle
    if (this.ui.btnToggleHeroDesc) {
      this.ui.btnToggleHeroDesc.addEventListener('click', () => {
        const isHidden = this.ui.heroDescText.classList.toggle('hidden');
        this.ui.btnToggleHeroDesc.textContent = isHidden ? '表示' : '閉じる';
      });
    }

    // Book Edit & Add
    this.ui.btnAddBook.addEventListener('click', () => this.openBookEditModal(null));
    this.ui.btnEditBook.addEventListener('click', () => this.openBookEditModal(this.currentBook));
    this.ui.btnCloseBookModal.addEventListener('click', () => this.closeModal('modalBookEdit'));
    this.ui.btnSaveBook.addEventListener('click', () => this.handleSaveBook());
    this.ui.btnDeleteBook.addEventListener('click', () => this.handleDeleteBook());

    // Front Cover Camera & Library Handlers
    if (this.ui.btnFrontCamera) {
      this.ui.btnFrontCamera.addEventListener('click', () => this.ui.fileCoverFrontCam.click());
    }
    if (this.ui.btnFrontLibrary) {
      this.ui.btnFrontLibrary.addEventListener('click', () => this.ui.fileCoverFrontLib.click());
    }
    if (this.ui.slotCoverFront) {
      this.ui.slotCoverFront.addEventListener('click', (e) => {
        if (e.target.closest('#btn-remove-cover-front')) return;
        if (!this.pendingCoverFront) {
          this.ui.fileCoverFrontCam.click();
        }
      });
    }
    if (this.ui.fileCoverFrontCam) {
      this.ui.fileCoverFrontCam.addEventListener('change', (e) => this.handleCoverPhotoUpload(e, 'front'));
    }
    if (this.ui.fileCoverFrontLib) {
      this.ui.fileCoverFrontLib.addEventListener('change', (e) => this.handleCoverPhotoUpload(e, 'front'));
    }

    // Back Cover Camera & Library Handlers
    if (this.ui.btnBackCamera) {
      this.ui.btnBackCamera.addEventListener('click', () => this.ui.fileCoverBackCam.click());
    }
    if (this.ui.btnBackLibrary) {
      this.ui.btnBackLibrary.addEventListener('click', () => this.ui.fileCoverBackLib.click());
    }
    if (this.ui.slotCoverBack) {
      this.ui.slotCoverBack.addEventListener('click', (e) => {
        if (e.target.closest('#btn-remove-cover-back')) return;
        if (!this.pendingCoverBack) {
          this.ui.fileCoverBackCam.click();
        }
      });
    }
    if (this.ui.fileCoverBackCam) {
      this.ui.fileCoverBackCam.addEventListener('change', (e) => this.handleCoverPhotoUpload(e, 'back'));
    }
    if (this.ui.fileCoverBackLib) {
      this.ui.fileCoverBackLib.addEventListener('change', (e) => this.handleCoverPhotoUpload(e, 'back'));
    }

    this.ui.btnRemoveCoverFront.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeCoverPhoto('front');
    });
    this.ui.btnRemoveCoverBack.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeCoverPhoto('back');
    });
    this.ui.btnExtractBookAI.addEventListener('click', () => this.handleExtractBookMetadataAI());

    // Settings
    this.ui.btnSettings.addEventListener('click', () => this.openSettingsModal());
    this.ui.btnCloseSettingsModal.addEventListener('click', () => this.closeModal('modalSettings'));
    this.ui.btnSaveSettings.addEventListener('click', () => this.handleSaveSettings());
    this.ui.btnLoadSampleData.addEventListener('click', () => this.loadSampleDataset());
    this.ui.btnExportBackup.addEventListener('click', () => this.exportBackupJSON());
    this.ui.btnImportBackupTrigger.addEventListener('click', () => this.ui.fileBackupInput.click());
    this.ui.fileBackupInput.addEventListener('change', (e) => this.importBackupJSON(e));

    // API Key Toggle & Paste
    if (this.ui.btnToggleKeyVisibility) {
      this.ui.btnToggleKeyVisibility.addEventListener('click', () => {
        const isPass = this.ui.inputGeminiKey.type === 'password';
        this.ui.inputGeminiKey.type = isPass ? 'text' : 'password';
        this.ui.btnToggleKeyVisibility.textContent = isPass ? '🙈' : '👁️';
      });
    }
    if (this.ui.btnPasteApiKey) {
      this.ui.btnPasteApiKey.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            const text = await navigator.clipboard.readText();
            if (text && text.trim()) {
              this.ui.inputGeminiKey.value = text.trim();
              this.showToast('📋 クリップボードからAPIキーを貼り付けました');
              return;
            }
          }
        } catch (err) {
          console.warn('Clipboard readText failed or denied:', err);
        }
        // Fallback: focus and select
        this.ui.inputGeminiKey.focus();
        this.ui.inputGeminiKey.select();
        this.showToast('入力欄をタップして貼り付けてください');
      });
    }

    // TOC Tree Actions
    this.ui.btnExpandAll.addEventListener('click', () => this.toggleAllChapters(true));
    this.ui.btnCollapseAll.addEventListener('click', () => this.toggleAllChapters(false));
    this.ui.btnImportTOC.addEventListener('click', () => this.openTOCImportModal());
    this.ui.btnEmptyImportTOC.addEventListener('click', () => this.openTOCImportModal());
    this.ui.btnCloseTOCModal.addEventListener('click', () => this.closeModal('modalTOCImport'));
    
    // Multi-Page TOC Upload & Actions (Dual Camera / Library)
    if (this.ui.btnDropzoneCam) {
      this.ui.btnDropzoneCam.addEventListener('click', () => this.ui.fileTOCCam.click());
    }
    if (this.ui.btnDropzoneLib) {
      this.ui.btnDropzoneLib.addEventListener('click', () => this.ui.fileTOCLib.click());
    }
    if (this.ui.btnAddTOCCam) {
      this.ui.btnAddTOCCam.addEventListener('click', () => this.ui.fileTOCCam.click());
    }
    if (this.ui.btnAddTOCLib) {
      this.ui.btnAddTOCLib.addEventListener('click', () => this.ui.fileTOCLib.click());
    }
    if (this.ui.fileTOCCam) {
      this.ui.fileTOCCam.addEventListener('change', (e) => this.handleTOCImageUpload(e));
    }
    if (this.ui.fileTOCLib) {
      this.ui.fileTOCLib.addEventListener('change', (e) => this.handleTOCImageUpload(e));
    }
    this.ui.btnClearTOCPages.addEventListener('click', () => this.clearTOCPages());
    this.ui.btnParseTOCAI.addEventListener('click', () => this.handleParseTOC());
    this.ui.btnConfirmTOC.addEventListener('click', () => this.handleConfirmTOC());

    // Memo Sheet Actions
    this.ui.btnCloseMemoSheet.addEventListener('click', () => this.closeModal('modalMemoSheet'));
    this.ui.btnRecordToggle.addEventListener('click', () => this.voiceHelper?.toggle());
    this.ui.btnQuickVoice.addEventListener('click', () => this.openQuickVoiceMemo());
    this.ui.btnSaveMemoAI.addEventListener('click', () => this.handleSaveMemo(true));
    this.ui.btnSaveMemoRaw.addEventListener('click', () => this.handleSaveMemo(false));

    // Memo Filters
    this.ui.memoFilterChips.forEach(chip => {
      chip.addEventListener('click', (e) => {
        this.ui.memoFilterChips.forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        this.renderMemoFeed(e.target.getAttribute('data-filter'));
      });
    });

    // Note Studio
    this.ui.btnHeroGenerateNote.addEventListener('click', () => {
      this.switchView('view-studio');
    });

    this.ui.studioTargetScope.addEventListener('change', (e) => {
      this.ui.studioChapterSelectGroup.style.display = e.target.value === 'selected-chapter' ? 'block' : 'none';
    });

    this.ui.btnGenerateNotePlan.addEventListener('click', () => this.handleGenerateNotePlan());
    this.ui.btnCopyPlanMd.addEventListener('click', () => this.copyNotePlanMarkdown());
    this.ui.btnDownloadPlanMd.addEventListener('click', () => this.downloadNotePlanMarkdown());
  }

  // ========================================================================
  // View & UI Navigation
  // ========================================================================
  switchView(viewId) {
    this.ui.views.forEach(view => {
      view.classList.toggle('active', view.id === viewId);
    });

    this.ui.navItems.forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-view') === viewId);
    });

    if (viewId === 'view-memos') {
      this.renderMemoFeed();
    } else if (viewId === 'view-studio') {
      this.updateStudioOptions();
    }
  }

  showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.innerHTML = `<span>✨</span> <span>${message}</span>`;
    this.ui.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  openModal(modalKey) {
    this.ui[modalKey].classList.remove('hidden');
  }

  closeModal(modalKey) {
    this.ui[modalKey].classList.add('hidden');
    if (modalKey === 'modalMemoSheet' && this.voiceHelper) {
      this.voiceHelper.stop();
    }
  }

  // ========================================================================
  // Settings & Gemini Config
  // ========================================================================
  async loadSettings() {
    const apiKey = await this.db.getSetting('gemini_api_key', '');
    let model = await this.db.getSetting('gemini_model', 'gemini-3.6-flash');
    if (!model || model.includes('gemini-2.') || model.includes('gemini-1.') || model.includes('gemini-3.8')) {
      model = 'gemini-3.6-flash';
      await this.db.saveSetting('gemini_model', model);
    }
    this.gemini.setApiKey(apiKey);
    this.gemini.setModel(model);

    this.ui.inputGeminiKey.value = apiKey;
    this.ui.selectGeminiModel.value = model;
  }

  openSettingsModal() {
    this.openModal('modalSettings');
  }

  async handleSaveSettings() {
    const key = this.ui.inputGeminiKey.value.trim();
    const model = this.ui.selectGeminiModel.value;

    await this.db.saveSetting('gemini_api_key', key);
    await this.db.saveSetting('gemini_model', model);

    this.gemini.setApiKey(key);
    this.gemini.setModel(model);

    this.closeModal('modalSettings');
    this.showToast('設定を保存しました');
  }

  // ========================================================================
  // Books & TOC Management
  // ========================================================================
  async loadBooksAndSetCurrent() {
    const books = await this.db.getAllBooks();
    this.renderBookSelectDropdown(books);

    if (books.length > 0) {
      const lastBookId = await this.db.getSetting('last_selected_book', books[0].id);
      const selected = books.find(b => b.id === lastBookId) || books[0];
      await this.selectBook(selected.id);
    } else {
      // Automatically load sample dataset on initial launch for supreme UX
      await this.loadSampleDataset();
    }
  }

  renderBookSelectDropdown(books) {
    this.ui.bookSelect.innerHTML = '';
    books.forEach(book => {
      const opt = document.createElement('option');
      opt.value = book.id;
      opt.textContent = `${book.title} (${book.author || '著者未設定'})`;
      this.ui.bookSelect.appendChild(opt);
    });
  }

  async selectBook(bookId) {
    this.currentBook = await this.db.getBook(bookId);
    if (!this.currentBook) return;

    await this.db.saveSetting('last_selected_book', bookId);
    this.ui.bookSelect.value = bookId;

    // Update Hero UI
    this.ui.heroTitle.textContent = this.currentBook.title;
    this.ui.heroAuthor.textContent = this.currentBook.author || '著者名未設定';
    
    // Cover Image or Initial
    if (this.currentBook.coverImage) {
      this.ui.heroCoverImg.src = this.currentBook.coverImage;
      this.ui.heroCoverImg.classList.remove('hidden');
      this.ui.heroCoverText.classList.add('hidden');
    } else {
      this.ui.heroCoverImg.classList.add('hidden');
      this.ui.heroCoverText.classList.remove('hidden');
      this.ui.heroCoverText.textContent = this.currentBook.title.slice(0, 1) || '本';
    }

    // Metadata Badges (Theme, Publisher, Published Date)
    if (this.currentBook.theme) {
      this.ui.heroThemeBadge.textContent = this.currentBook.theme;
      this.ui.heroThemeBadge.classList.remove('hidden');
    } else {
      this.ui.heroThemeBadge.classList.add('hidden');
    }

    if (this.currentBook.publisher) {
      this.ui.heroPublisherBadge.textContent = this.currentBook.publisher;
      this.ui.heroPublisherBadge.classList.remove('hidden');
    } else {
      this.ui.heroPublisherBadge.classList.add('hidden');
    }

    if (this.currentBook.publishedDate) {
      this.ui.heroPublishedBadge.textContent = `📅 ${this.currentBook.publishedDate}`;
      this.ui.heroPublishedBadge.classList.remove('hidden');
    } else {
      this.ui.heroPublishedBadge.classList.add('hidden');
    }

    // Book Back Description Accordion
    if (this.currentBook.description) {
      this.ui.heroDescContainer.classList.remove('hidden');
      this.ui.heroDescText.textContent = this.currentBook.description;
      this.ui.heroDescText.classList.add('hidden'); // Initially collapsed
      this.ui.btnToggleHeroDesc.textContent = '表示';
    } else {
      this.ui.heroDescContainer.classList.add('hidden');
    }

    await this.refreshBookData();
  }

  async refreshBookData() {
    if (!this.currentBook) return;

    const memos = await this.db.getMemosByBook(this.currentBook.id);
    const chapters = this.currentBook.toc || [];

    this.ui.heroMemoCount.textContent = memos.length;
    this.ui.heroChapterCount.textContent = chapters.length;
    this.ui.navBadgeCount.textContent = memos.length;

    this.renderTOCTree(chapters, memos);
  }

  // ========================================================================
  // Book Edit Modal & Cover/Back Photo Extraction
  // ========================================================================
  openBookEditModal(book = null) {
    this.pendingCoverFront = null;
    this.pendingCoverBack = null;
    this.ui.bookExtractLoading.classList.add('hidden');
    this.ui.btnExtractBookAI.disabled = true;

    // Reset photos
    this.ui.imgPreviewFront.src = '';
    this.ui.imgPreviewFront.classList.add('hidden');
    this.ui.btnRemoveCoverFront.classList.add('hidden');
    this.ui.slotCoverFront.querySelector('.photo-placeholder').classList.remove('hidden');

    this.ui.imgPreviewBack.src = '';
    this.ui.imgPreviewBack.classList.add('hidden');
    this.ui.btnRemoveCoverBack.classList.add('hidden');
    this.ui.slotCoverBack.querySelector('.photo-placeholder').classList.remove('hidden');

    if (book) {
      this.ui.bookModalTitle.textContent = '書籍情報の編集';
      this.ui.inputBookTitle.value = book.title || '';
      this.ui.inputBookAuthor.value = book.author || '';
      this.ui.inputBookPublished.value = book.publishedDate || '';
      this.ui.inputBookPublisher.value = book.publisher || '';
      this.ui.inputBookTheme.value = book.theme || '';
      this.ui.inputBookDescription.value = book.description || '';
      this.ui.btnDeleteBook.classList.remove('hidden');
      this.editingBookId = book.id;

      // If existing cover image
      if (book.coverImage) {
        this.pendingCoverFront = { dataUrl: book.coverImage, isExisting: true };
        this.ui.imgPreviewFront.src = book.coverImage;
        this.ui.imgPreviewFront.classList.remove('hidden');
        this.ui.btnRemoveCoverFront.classList.remove('hidden');
        this.ui.slotCoverFront.querySelector('.photo-placeholder').classList.add('hidden');
      }
    } else {
      this.ui.bookModalTitle.textContent = '新しい書籍の追加';
      this.ui.inputBookTitle.value = '';
      this.ui.inputBookAuthor.value = '';
      this.ui.inputBookPublished.value = '';
      this.ui.inputBookPublisher.value = '';
      this.ui.inputBookTheme.value = '';
      this.ui.inputBookDescription.value = '';
      this.ui.btnDeleteBook.classList.add('hidden');
      this.editingBookId = null;
    }

    this.openModal('modalBookEdit');
  }

  async resizeAndConvertToBase64(file, maxWidth = 1200) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          try {
            let w = img.width;
            let h = img.height;
            if (w > maxWidth) {
              h = Math.round((h * maxWidth) / w);
              w = maxWidth;
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(dataUrl);
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = () => reject(new Error('画像の展開に失敗しました。'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('写真ファイルの読み込みに失敗しました。'));
      reader.readAsDataURL(file);
    });
  }

  async handleCoverPhotoUpload(event, type) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      this.showToast('写真を処理中...');
      const base64DataUrl = await this.resizeAndConvertToBase64(file, 1200);
      const item = {
        dataUrl: base64DataUrl,
        base64: base64DataUrl.split(',')[1],
        mimeType: 'image/jpeg'
      };

      if (type === 'front') {
        this.pendingCoverFront = item;
        this.ui.imgPreviewFront.src = base64DataUrl;
        this.ui.imgPreviewFront.classList.remove('hidden');
        this.ui.btnRemoveCoverFront.classList.remove('hidden');
        this.ui.slotCoverFront.querySelector('.photo-placeholder').classList.add('hidden');
      } else {
        this.pendingCoverBack = item;
        this.ui.imgPreviewBack.src = base64DataUrl;
        this.ui.imgPreviewBack.classList.remove('hidden');
        this.ui.btnRemoveCoverBack.classList.remove('hidden');
        this.ui.slotCoverBack.querySelector('.photo-placeholder').classList.add('hidden');
      }

      // Enable AI extraction button if at least one photo is present
      this.ui.btnExtractBookAI.disabled = false;
      this.showToast(type === 'front' ? '📘 表紙を取り込みました' : '📄 奥付を取り込みました');
    } catch (err) {
      console.error(err);
      alert('写真の処理中にエラーが発生しました: ' + err.message);
    } finally {
      event.target.value = ''; // Reset input to allow re-uploading same file
    }
  }

  removeCoverPhoto(type) {
    if (type === 'front') {
      this.pendingCoverFront = null;
      this.ui.imgPreviewFront.src = '';
      this.ui.imgPreviewFront.classList.add('hidden');
      this.ui.btnRemoveCoverFront.classList.add('hidden');
      this.ui.slotCoverFront.querySelector('.photo-placeholder').classList.remove('hidden');
    } else {
      this.pendingCoverBack = null;
      this.ui.imgPreviewBack.src = '';
      this.ui.imgPreviewBack.classList.add('hidden');
      this.ui.btnRemoveCoverBack.classList.add('hidden');
      this.ui.slotCoverBack.querySelector('.photo-placeholder').classList.remove('hidden');
    }

    if (!this.pendingCoverFront && !this.pendingCoverBack) {
      this.ui.btnExtractBookAI.disabled = true;
    }
  }

  async handleExtractBookMetadataAI() {
    const imagesToProcess = [];
    if (this.pendingCoverFront && this.pendingCoverFront.base64) {
      imagesToProcess.push({
        base64: this.pendingCoverFront.base64,
        mimeType: 'image/jpeg'
      });
    }
    if (this.pendingCoverBack && this.pendingCoverBack.base64) {
      imagesToProcess.push({
        base64: this.pendingCoverBack.base64,
        mimeType: 'image/jpeg'
      });
    }

    if (imagesToProcess.length === 0) {
      alert('表紙または奥付の写真を1枚以上撮影・選択してください');
      return;
    }

    const btn = this.ui.btnExtractBookAI;
    btn.disabled = true;
    btn.textContent = '⏳ AIで書籍情報を解析中...';
    this.ui.bookExtractLoading.classList.remove('hidden');

    try {
      let meta = null;
      if (this.gemini.hasApiKey()) {
        meta = await this.gemini.extractBookMetadata(imagesToProcess);
      } else {
        // Fallback demo simulation if API key is not yet set
        meta = {
          title: "紙の本からアイデアを創る技術",
          author: "建築太郎",
          publishedDate: "2024年3月",
          publisher: "技報堂出版",
          theme: "建築・施工管理",
          description: "現場で磨かれた観察眼と積算力を武器に、書籍から本質的な知識を抽出し、note記事として爆速アウトプットするための実践的ガイドブック。"
        };
        this.showToast('⚠️ APIキー未設定のため、サンプル抽出データを転記しました（右上の⚙️から無料キーを設定してください）');
      }

      if (meta) {
        if (meta.title) this.ui.inputBookTitle.value = meta.title;
        if (meta.author) this.ui.inputBookAuthor.value = meta.author;
        if (meta.publishedDate) this.ui.inputBookPublished.value = meta.publishedDate;
        if (meta.publisher) this.ui.inputBookPublisher.value = meta.publisher;
        if (meta.theme) this.ui.inputBookTheme.value = meta.theme;
        if (meta.description) this.ui.inputBookDescription.value = meta.description;

        this.showToast('✨ 表紙・奥付から書籍情報を自動転記しました！');
      }
    } catch (err) {
      console.error(err);
      alert('書籍情報の抽出に失敗しました: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ AIで表紙・奥付から書籍情報を自動読取';
      this.ui.bookExtractLoading.classList.add('hidden');
    }
  }

  async handleSaveBook() {
    const title = this.ui.inputBookTitle.value.trim();
    if (!title) {
      alert('書籍タイトルを入力してください');
      return;
    }

    const id = this.editingBookId || 'book_' + Date.now();
    const existing = this.editingBookId ? await this.db.getBook(this.editingBookId) : null;

    // Determine cover image (use new front image, or keep existing)
    let coverImage = null;
    if (this.pendingCoverFront) {
      coverImage = this.pendingCoverFront.dataUrl;
    } else if (existing && existing.coverImage) {
      coverImage = existing.coverImage;
    }

    const book = {
      id,
      title,
      author: this.ui.inputBookAuthor.value.trim(),
      publishedDate: this.ui.inputBookPublished.value.trim(),
      publisher: this.ui.inputBookPublisher.value.trim(),
      theme: this.ui.inputBookTheme.value.trim(),
      description: this.ui.inputBookDescription.value.trim(),
      coverImage: coverImage,
      toc: existing ? existing.toc : [],
      updatedAt: new Date().toISOString(),
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };

    await this.db.saveBook(book);
    this.closeModal('modalBookEdit');
    this.showToast('書籍を保存しました');

    const books = await this.db.getAllBooks();
    this.renderBookSelectDropdown(books);
    await this.selectBook(id);
  }

  async handleDeleteBook() {
    if (!this.editingBookId) return;
    if (!confirm('この書籍と関連するすべてのメモを削除しますか？')) return;

    await this.db.deleteBook(this.editingBookId);
    this.closeModal('modalBookEdit');
    this.showToast('書籍を削除しました');

    const books = await this.db.getAllBooks();
    this.renderBookSelectDropdown(books);
    if (books.length > 0) {
      await this.selectBook(books[0].id);
    } else {
      this.currentBook = null;
      this.renderTOCTree([], []);
    }
  }

  // ========================================================================
  // TOC Rendering & Tree Logic
  // ========================================================================
  renderTOCTree(chapters, memos) {
    const container = this.ui.tocTreeContainer;
    container.innerHTML = '';

    if (!chapters || chapters.length === 0) {
      this.ui.tocEmptyState.classList.remove('hidden');
      container.classList.add('hidden');
      return;
    }

    this.ui.tocEmptyState.classList.add('hidden');
    container.classList.remove('hidden');

    // Memo lookup by sectionId
    const memosBySection = {};
    memos.forEach(m => {
      if (!memosBySection[m.sectionId]) memosBySection[m.sectionId] = [];
      memosBySection[m.sectionId].push(m);
    });

    chapters.forEach((ch, chIdx) => {
      const chapterBlock = document.createElement('div');
      chapterBlock.className = 'chapter-block open';
      chapterBlock.id = `ch-block-${ch.id || chIdx}`;

      // Chapter Header
      const header = document.createElement('div');
      header.className = 'chapter-header';
      header.innerHTML = `
        <div class="chapter-title-wrapper">
          <span class="chapter-toggle-icon">▶</span>
          <span class="chapter-title">${ch.chapterNumber ? ch.chapterNumber + ' ' : ''}${ch.chapterTitle}</span>
        </div>
        <div class="chapter-badge-group">
          <span class="stat-badge">${ch.sections ? ch.sections.length : 0} 節</span>
        </div>
      `;

      header.addEventListener('click', () => {
        chapterBlock.classList.toggle('open');
      });

      // Section List
      const sectionList = document.createElement('div');
      sectionList.className = 'section-list';

      if (ch.sections && ch.sections.length > 0) {
        ch.sections.forEach((sec, secIdx) => {
          const secId = sec.id || `s_${chIdx}_${secIdx}`;
          const secMemos = memosBySection[secId] || [];

          const secCard = document.createElement('div');
          secCard.className = 'section-item-card';

          const secMain = document.createElement('div');
          secMain.className = 'section-item-main';
          secMain.innerHTML = `
            <div class="section-label-group">
              <span class="section-item-title">${sec.sectionNumber ? sec.sectionNumber + ' ' : ''}${sec.sectionTitle}</span>
            </div>
            <button class="section-add-btn" title="この節にメモを記録">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              <span>メモ</span>
              ${secMemos.length > 0 ? `<strong style="margin-left:2px;">(${secMemos.length})</strong>` : ''}
            </button>
          `;

          // Add memo button handler
          const addBtn = secMain.querySelector('.section-add-btn');
          addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openMemoSheet(ch, sec, secId);
          });

          secCard.appendChild(secMain);

          // Attached Memos under Section
          if (secMemos.length > 0) {
            const memoBox = document.createElement('div');
            memoBox.className = 'section-attached-memos';

            secMemos.forEach(m => {
              const memoItem = document.createElement('div');
              memoItem.className = 'memo-raw-text';
              memoItem.style.fontSize = '0.84rem';
              memoItem.style.padding = '6px 8px';
              memoItem.style.background = 'rgba(15, 23, 42, 0.6)';
              memoItem.style.borderRadius = '6px';
              memoItem.style.marginBottom = '4px';

              let aiSnippet = '';
              if (m.noteAngle) {
                aiSnippet = `<div style="font-size:0.78rem; color:#d8b4fe; margin-top:4px;">✍️ <strong>note切り口:</strong> ${m.noteAngle}</div>`;
              }

              memoItem.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <div>${m.text}</div>
                  <button class="mini-icon-btn del-btn" title="メモを削除" style="color:#ef4444;">&times;</button>
                </div>
                ${aiSnippet}
              `;

              memoItem.querySelector('.del-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('このメモを削除しますか？')) {
                  await this.db.deleteMemo(m.id);
                  this.showToast('メモを削除しました');
                  await this.refreshBookData();
                }
              });

              memoBox.appendChild(memoItem);
            });

            secCard.appendChild(memoBox);
          }

          sectionList.appendChild(secCard);
        });
      }

      chapterBlock.appendChild(header);
      chapterBlock.appendChild(sectionList);
      container.appendChild(chapterBlock);
    });
  }

  toggleAllChapters(expand = true) {
    const blocks = document.querySelectorAll('.chapter-block');
    blocks.forEach(b => {
      b.classList.toggle('open', expand);
    });
  }

  // ========================================================================
  // Multi-Page TOC Import & Gemini Vision Analysis
  // ========================================================================
  openTOCImportModal() {
    this.pendingTOCPages = [];
    this.parsedTOCData = null;
    this.ui.manualTOCText.value = '';
    this.ui.tocParsedPreviewBox.classList.add('hidden');
    this.ui.tocParseLoading.classList.add('hidden');
    this.ui.btnConfirmTOC.classList.add('hidden');
    this.ui.btnParseTOCAI.classList.remove('hidden');
    this.ui.btnParseTOCAI.disabled = true;

    this.renderTOCPageList();
    this.openModal('modalTOCImport');
  }

  async handleTOCImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      const resizedBase64 = await this.resizeAndConvertToBase64(file, 1600);
      this.pendingTOCPages.push({
        id: 'toc_page_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        dataUrl: resizedBase64,
        base64: resizedBase64.split(',')[1],
        mimeType: file.type || 'image/jpeg'
      });
    }

    event.target.value = ''; // Reset file input to allow consecutive additions
    this.renderTOCPageList();
  }

  renderTOCPageList() {
    const container = this.ui.tocPageListContainer;
    container.innerHTML = '';

    const count = this.pendingTOCPages.length;
    this.ui.tocPageBadge.textContent = `${count} ページ選択中`;

    if (count === 0) {
      container.classList.add('hidden');
      this.ui.dropzoneTOC.classList.remove('hidden');
      this.ui.btnClearTOCPages.classList.add('hidden');
      this.ui.btnParseTOCAI.disabled = true;
      return;
    }

    container.classList.remove('hidden');
    this.ui.dropzoneTOC.classList.add('hidden');
    this.ui.btnClearTOCPages.classList.remove('hidden');
    this.ui.btnParseTOCAI.disabled = false;

    this.pendingTOCPages.forEach((page, index) => {
      const card = document.createElement('div');
      card.className = 'toc-page-card';

      card.innerHTML = `
        <div class="toc-page-img-wrap">
          <img src="${page.dataUrl}" alt="目次P${index + 1}" class="toc-page-thumb">
          <span class="page-order-badge">P.${index + 1}</span>
          <button type="button" class="page-quick-rotate" title="90°右回転">🔄</button>
        </div>
        <div class="toc-page-actions">
          <button type="button" class="page-ctrl-btn move-left" title="前へ" ${index === 0 ? 'disabled' : ''}>◀</button>
          <button type="button" class="page-ctrl-btn page-rotate-btn" title="画像を90°回転">🔄 回転</button>
          <button type="button" class="page-ctrl-btn move-right" title="次へ" ${index === count - 1 ? 'disabled' : ''}>▶</button>
          <button type="button" class="page-ctrl-btn page-del-btn" title="削除">&times;</button>
        </div>
      `;

      // Quick Rotate on thumbnail badge
      card.querySelector('.page-quick-rotate').addEventListener('click', (e) => {
        e.stopPropagation();
        this.rotateTOCPage(index);
      });

      // Rotate Button in action bar
      card.querySelector('.page-rotate-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.rotateTOCPage(index);
      });

      // Move Left
      card.querySelector('.move-left').addEventListener('click', (e) => {
        e.stopPropagation();
        this.moveTOCPage(index, -1);
      });

      // Move Right
      card.querySelector('.move-right').addEventListener('click', (e) => {
        e.stopPropagation();
        this.moveTOCPage(index, 1);
      });

      // Delete Page
      card.querySelector('.page-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeTOCPage(index);
      });

      container.appendChild(card);
    });
  }

  /**
   * 目次写真の90°時計回り回転処理（Canvas利用）
   */
  async rotateTOCPage(index) {
    const page = this.pendingTOCPages[index];
    if (!page || !page.dataUrl) return;

    try {
      this.showToast(`P.${index + 1} を回転中...`);
      const rotatedDataUrl = await this.rotateImageDataUrl(page.dataUrl, 90);
      page.dataUrl = rotatedDataUrl;
      page.base64 = rotatedDataUrl.split(',')[1];
      this.renderTOCPageList();
      this.showToast(`✅ P.${index + 1} を90°回転しました`);
    } catch (err) {
      console.error('Rotate image failed:', err);
      alert('画像の回転に失敗しました: ' + err.message);
    }
  }

  /**
   * Canvasを使ってDataURL画像を任意の角度（時計回り）に回転
   */
  rotateImageDataUrl(dataUrl, degrees = 90) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const rad = (degrees * Math.PI) / 180;

        if (degrees === 90 || degrees === 270) {
          canvas.width = img.height;
          canvas.height = img.width;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(rad);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = (e) => reject(new Error('画像の読み込みに失敗しました'));
      img.src = dataUrl;
    });
  }

  moveTOCPage(index, direction) {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= this.pendingTOCPages.length) return;

    const item = this.pendingTOCPages.splice(index, 1)[0];
    this.pendingTOCPages.splice(targetIdx, 0, item);
    this.renderTOCPageList();
  }

  removeTOCPage(index) {
    this.pendingTOCPages.splice(index, 1);
    this.renderTOCPageList();
  }

  clearTOCPages() {
    if (this.pendingTOCPages.length === 0) return;
    if (confirm('追加した目次ページ写真をすべてクリアしますか？')) {
      this.pendingTOCPages = [];
      this.renderTOCPageList();
    }
  }

  async handleParseTOC() {
    if (!this.currentBook) {
      alert('書籍が選択されていません');
      return;
    }

    const manualText = this.ui.manualTOCText.value.trim();
    if (this.pendingTOCPages.length === 0 && !manualText) {
      alert('目次ページの写真を追加するか、手動テキストを入力してください');
      return;
    }

    const btn = this.ui.btnParseTOCAI;
    btn.disabled = true;
    this.ui.tocParseLoading.classList.remove('hidden');
    this.ui.tocLoadingText.textContent = `Gemini Vision で ${this.pendingTOCPages.length} ページの目次を統合解析中...`;

    const images = this.pendingTOCPages.map(p => ({
      inlineData: {
        data: p.base64,
        mimeType: p.mimeType
      }
    }));

    try {
      let parsedTOC = null;

      if (!this.gemini.hasApiKey()) {
        if (manualText && manualText.trim().length > 0) {
          parsedTOC = this.fallbackParseTOCText(manualText);
          this.showToast('APIキー未設定のため、入力テキストから目次を抽出しました');
        } else {
          throw new Error('Gemini APIキーが設定されていません。画面右上の⚙️設定から無料のAPIキーを入力してください。');
        }
      } else {
        parsedTOC = await this.gemini.parseTOC(images, manualText);
      }

      if (!parsedTOC || parsedTOC.length === 0) {
        throw new Error('目次のパースに失敗しました。画像が鮮明かご確認いただくか、手動テキストをご入力ください。');
      }

      // Store in instance
      this.parsedTOCData = parsedTOC;

      // Render Parsed Preview
      this.renderTOCParsedPreview(parsedTOC);

      // Show Confirm Button
      btn.classList.add('hidden');
      this.ui.btnConfirmTOC.classList.remove('hidden');

      this.showToast('✨ 目次ツリーの解析に成功しました！プレビューを確認して適用してください。');

    } catch (err) {
      console.error('Gemini parseTOC failed:', err);
      if (manualText && manualText.trim().length > 0) {
        const rescuedTOC = this.fallbackParseTOCText(manualText);
        this.parsedTOCData = rescuedTOC;
        this.renderTOCParsedPreview(rescuedTOC);
        btn.classList.add('hidden');
        this.ui.btnConfirmTOC.classList.remove('hidden');
        this.showToast('⚠️ 入力テキストから目次ツリーを復元しました。');
      } else {
        alert(`⚠️ 目次の解析に失敗しました\n\n【詳細】: ${err.message}\n\n【改善のヒント】\n・写真が上下逆さまや横向きの場合は、各写真の「🔄」または「🔄 回転」ボタンを押して文字がまっすぐ読める向きにしてから再度お試しください。\n・APIキーが正しいか右上の⚙️設定をご確認ください。`);
      }
    } finally {
      btn.disabled = false;
      this.ui.tocParseLoading.classList.add('hidden');
    }
  }

  renderTOCParsedPreview(chapters) {
    let totalSections = 0;
    chapters.forEach(ch => {
      totalSections += (ch.sections ? ch.sections.length : 0);
    });

    this.ui.tocParsedCount.textContent = `全 ${chapters.length} 章 / 全 ${totalSections} 節`;
    this.ui.tocParsedList.innerHTML = '';

    chapters.forEach((ch, idx) => {
      const chItem = document.createElement('div');
      chItem.className = 'parsed-ch-item';

      const secTitles = (ch.sections || []).map(s => `・${s.sectionNumber ? s.sectionNumber + ' ' : ''}${s.sectionTitle}`).join('<br>');
      chItem.innerHTML = `
        <div class="parsed-ch-title">${ch.chapterNumber ? ch.chapterNumber + ' ' : ''}${ch.chapterTitle}</div>
        <div class="parsed-sec-list">${secTitles || '（節なし）'}</div>
      `;
      this.ui.tocParsedList.appendChild(chItem);
    });

    this.ui.tocParsedPreviewBox.classList.remove('hidden');
  }

  async handleConfirmTOC() {
    if (!this.parsedTOCData) return;

    this.currentBook.toc = this.parsedTOCData;
    await this.db.saveBook(this.currentBook);

    this.closeModal('modalTOCImport');
    this.showToast('✅ 目次ツリーを適用・保存しました！');
    await this.refreshBookData();
  }

  fallbackParseTOCText(text) {
    if (!text) {
      return [
        {
          id: 'c1',
          chapterNumber: '第1章',
          chapterTitle: '基礎と着眼点',
          sections: [
            { id: 's1_1', sectionNumber: '1-1', sectionTitle: 'はじめの一歩' },
            { id: 's1_2', sectionNumber: '1-2', sectionTitle: '現場のチェックポイント' }
          ]
        }
      ];
    }

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const result = [];
    let currentCh = null;

    lines.forEach((line, idx) => {
      if (line.startsWith('第') || line.includes('章') || !currentCh) {
        currentCh = {
          id: `c_${idx}`,
          chapterNumber: line.split(' ')[0] || `第${result.length + 1}章`,
          chapterTitle: line,
          sections: []
        };
        result.push(currentCh);
      } else {
        currentCh.sections.push({
          id: `s_${idx}`,
          sectionNumber: `${result.length}-${currentCh.sections.length + 1}`,
          sectionTitle: line
        });
      }
    });

    return result;
  }

  // ========================================================================
  // Voice & Text Memo Recording
  // ========================================================================
  async initVoiceRecognition() {
    this.voiceHelper = new VoiceRecognitionHelper(
      (transcript) => {
        // Real-time update text area
        this.ui.inputMemoText.value = transcript;
      },
      (isRecording, statusMsg) => {
        this.ui.btnRecordToggle.classList.toggle('recording', isRecording);
        this.ui.voiceStatusText.textContent = statusMsg;
        this.ui.voiceWaveAnim.classList.toggle('hidden', !isRecording);
      }
    );
  }

  openMemoSheet(chapter, section, sectionId) {
    this.currentSection = {
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.chapterTitle,
      sectionId: sectionId,
      sectionNumber: section.sectionNumber,
      sectionTitle: section.sectionTitle
    };

    this.ui.memoSheetChapter.textContent = `${chapter.chapterNumber || ''} ${section.sectionNumber || ''}`.trim();
    this.ui.memoSheetTitle.textContent = section.sectionTitle || 'メモを記録';
    this.ui.inputMemoText.value = '';
    this.ui.inputMemoText.focus();

    this.openModal('modalMemoSheet');
  }

  openQuickVoiceMemo() {
    if (!this.currentBook || !this.currentBook.toc || this.currentBook.toc.length === 0) {
      alert('先に書籍を選択し、目次を取り込んでください。');
      return;
    }
    const firstCh = this.currentBook.toc[0];
    const firstSec = firstCh.sections?.[0] || { id: 's_quick', sectionTitle: '全体・クイックメモ' };
    this.openMemoSheet(firstCh, firstSec, firstSec.id);
  }

  async handleSaveMemo(useAI = true) {
    const rawText = this.ui.inputMemoText.value.trim();
    if (!rawText) {
      alert('メモを入力または音声で吹き込んでください');
      return;
    }

    if (!this.currentBook || !this.currentSection) return;

    const btn = useAI ? this.ui.btnSaveMemoAI : this.ui.btnSaveMemoRaw;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = useAI ? '🧠 AI構造化中...' : '保存中...';

    try {
      let aiResult = { summary: '', insight: '', noteAngle: '' };

      if (useAI) {
        const chapterContext = `${this.currentSection.chapterNumber} ${this.currentSection.sectionTitle}`;
        if (this.gemini.hasApiKey()) {
          aiResult = await this.gemini.structureMemo(rawText, this.currentBook.title, chapterContext);
        } else {
          // Local fallback structuring
          aiResult = {
            summary: rawText.slice(0, 50) + '...',
            insight: '現場管理と建築補償の観点から、コストとリスクのバランスを見極めることが重要。',
            noteAngle: `【一級建築士の視点】${this.currentSection.sectionTitle}で直面する失敗の防ぎ方`
          };
        }
      }

      const memo = {
        id: 'memo_' + Date.now(),
        bookId: this.currentBook.id,
        sectionId: this.currentSection.sectionId,
        chapterNumber: this.currentSection.chapterNumber,
        sectionTitle: this.currentSection.sectionTitle,
        text: rawText,
        summary: aiResult.summary || '',
        insight: aiResult.insight || '',
        noteAngle: aiResult.noteAngle || '',
        starred: false,
        createdAt: new Date().toISOString()
      };

      await this.db.saveMemo(memo);
      this.closeModal('modalMemoSheet');
      this.showToast(useAI ? 'AI構造化メモを保存しました！' : 'メモを保存しました');

      await this.refreshBookData();

    } catch (err) {
      console.error(err);
      alert('メモ保存中にエラーが発生しました: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  // ========================================================================
  // Memo Feed View
  // ========================================================================
  async renderMemoFeed(filter = 'all') {
    if (!this.currentBook) return;

    let memos = await this.db.getMemosByBook(this.currentBook.id);
    memos.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (filter === 'starred') {
      memos = memos.filter(m => m.starred);
    } else if (filter === 'note-idea') {
      memos = memos.filter(m => Boolean(m.noteAngle));
    }

    const container = this.ui.memoFeedContainer;
    container.innerHTML = '';

    if (memos.length === 0) {
      container.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-icon">💡</div>
          <h3>メモがまだありません</h3>
          <p>「目次ツリー」画面から節を選んで、読書中の気づきを音声やテキストで記録してください。</p>
        </div>
      `;
      return;
    }

    memos.forEach(m => {
      const card = document.createElement('div');
      card.className = 'memo-card';

      let aiBlock = '';
      if (m.summary || m.insight || m.noteAngle) {
        aiBlock = `
          <div class="ai-insights-box">
            ${m.summary ? `
              <div class="insight-row">
                <span class="insight-label label-summary">📌 要点サマリー</span>
                <span class="insight-text">${m.summary}</span>
              </div>` : ''}
            ${m.insight ? `
              <div class="insight-row">
                <span class="insight-label label-insight">💡 塩崎様の気づき・考察</span>
                <span class="insight-text">${m.insight}</span>
              </div>` : ''}
            ${m.noteAngle ? `
              <div class="insight-row">
                <span class="insight-label label-note">✍️ note記事の切り口（雪国アーキパパ）</span>
                <span class="insight-text">${m.noteAngle}</span>
              </div>` : ''}
          </div>
        `;
      }

      card.innerHTML = `
        <div class="memo-card-header">
          <span class="memo-chapter-tag">${m.chapterNumber || ''} ${m.sectionTitle || ''}</span>
          <div class="memo-card-actions">
            <button class="mini-icon-btn star-btn" title="お気に入り">${m.starred ? '★' : '☆'}</button>
            <button class="mini-icon-btn to-note-btn" title="このメモからnote企画案を作る">✍️</button>
            <button class="mini-icon-btn delete-btn" title="削除">&times;</button>
          </div>
        </div>
        <div class="memo-raw-text">${m.text}</div>
        ${aiBlock}
      `;

      // Star Handler
      card.querySelector('.star-btn').addEventListener('click', async () => {
        m.starred = !m.starred;
        await this.db.saveMemo(m);
        await this.renderMemoFeed(filter);
      });

      // Jump to Note Studio with this memo
      card.querySelector('.to-note-btn').addEventListener('click', () => {
        this.switchView('view-studio');
      });

      // Delete Handler
      card.querySelector('.delete-btn').addEventListener('click', async () => {
        if (confirm('このメモを削除しますか？')) {
          await this.db.deleteMemo(m.id);
          this.showToast('メモを削除しました');
          await this.renderMemoFeed(filter);
          await this.refreshBookData();
        }
      });

      container.appendChild(card);
    });
  }

  // ========================================================================
  // Note Studio (AI Plan Generator)
  // ========================================================================
  async updateStudioOptions() {
    if (!this.currentBook) return;

    this.ui.studioChapterSelect.innerHTML = '';
    (this.currentBook.toc || []).forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.chapterNumber ? ch.chapterNumber + ' ' : ''}${ch.chapterTitle}`;
      this.ui.studioChapterSelect.appendChild(opt);
    });
  }

  async handleGenerateNotePlan() {
    if (!this.currentBook) return;

    const btn = this.ui.btnGenerateNotePlan;
    btn.disabled = true;
    btn.textContent = '✨ 雪国アーキパパ視点でnote企画案を生成中...';

    const scope = this.ui.studioTargetScope.value;
    const toneText = this.ui.studioToneSelect.options[this.ui.studioToneSelect.selectedIndex].text;

    let targetMemos = await this.db.getMemosByBook(this.currentBook.id);

    if (scope === 'selected-chapter') {
      const targetChId = this.ui.studioChapterSelect.value;
      const targetCh = (this.currentBook.toc || []).find(c => c.id === targetChId);
      const secIds = (targetCh?.sections || []).map(s => s.id);
      targetMemos = targetMemos.filter(m => secIds.includes(m.sectionId));
    }

    if (targetMemos.length === 0) {
      alert('企画生成の対象となるメモがありません。まずは読書メモを記録してください。');
      btn.disabled = false;
      btn.textContent = 'note記事の企画案をAI生成する';
      return;
    }

    try {
      let markdownPlan = '';

      if (this.gemini.hasApiKey()) {
        markdownPlan = await this.gemini.generateNotePlan(this.currentBook.title, targetMemos, toneText);
      } else {
        // High quality fallback plan template
        markdownPlan = this.generateFallbackNotePlan(this.currentBook.title, targetMemos, toneText);
      }

      this.currentGeneratedPlan = markdownPlan;
      this.ui.notePlanContent.textContent = markdownPlan;
      this.ui.notePlanOutputContainer.classList.remove('hidden');
      this.ui.notePlanOutputContainer.scrollIntoView({ behavior: 'smooth' });

      this.showToast('note記事の企画案が完成しました！');

    } catch (err) {
      console.error(err);
      alert('企画案の生成中にエラーが発生しました: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'note記事の企画案をAI生成する';
    }
  }

  generateFallbackNotePlan(bookTitle, memos, tone) {
    const memoSample = memos[0] || {};
    return `# 💡 note記事 企画・構成案

## ■ 記事タイトル案（3パターン）
1. **【実録】現場監督が痛感した『${bookTitle}』のリアルな教訓と失敗回避法**
2. **なぜ図面通りに進まないのか？一級建築士が読み解く「現場判断」の本質**
3. **完全リモート×育休中の建築士パパが実践する、読書を武器に変える知識定着術**

## ■ 企画概要とターゲット読者
- **想定ターゲット**: 不動産投資初心者、現場管理や建築に関わる実務者、限られた時間で学びを最大化したいパパ・ママ読者
- **記事のゴール**: 「知っている」と「現場でできる」の決定的な差を理解し、読者が自信を持って判断できるようになる
- **雪国アーキパパならではの独自バリュー**: 
  - 準大手ゼネコン現場管理5年のコスト・工程・是正の生々しいリアル体験
  - 建築補償部での建物調査・積算根拠の確かな裏付け
  - 育休中のINFJらしい読者目線のあたたかな寄り添い

## ■ 導入（リード文）の展開イメージ
こんにちは、雪国アーキパパです。
本を読んでいる時は「なるほど！」と分かった気になっても、いざ実際の現場や投資判断になると頭が真っ白になること、ありませんか？
今回は『${bookTitle}』から得た知見を、私の現場での失敗談と掛け合わせて整理しました。

## ■ 目次・見出し構成案
- ## 1. 「教科書通り」が通用しない現場のリアル
  - メモより: ${memoSample.text || '図面と現場の乖離'}
  - 現場監督時代、最も手戻りが発生した典型パターン
- ## 2. 一級建築士が教える「最初のチェックポイント」
  - 要点: ${memoSample.summary || '事前の詳細調査とリスクの可視化'}
  - 見落としがちな3つの落とし穴
- ## 3. 失敗しないための「逆算思考」とコスト管理
  - 建築補償・積算目線で考えるリスクヘッジ
- ## 4. まとめ：今日からできる小さなアクション

## ■ 雪国アーキパパの執筆ワンポイントアドバイス
- 現場の専門用語は必ず平易な言葉に言い換えること（読者の心理的ハードルを下げる）。
- 成功談だけでなく「自分がやらかした冷や汗の体験」をあえて開示することで、読者との深い信頼関係が生まれます。
`;
  }

  copyNotePlanMarkdown() {
    if (!this.currentGeneratedPlan) return;
    navigator.clipboard.writeText(this.currentGeneratedPlan).then(() => {
      this.showToast('Markdownをクリップボードにコピーしました！');
    });
  }

  downloadNotePlanMarkdown() {
    if (!this.currentGeneratedPlan) return;
    const blob = new Blob([this.currentGeneratedPlan], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `note企画案_${this.currentBook.title}_${new Date().toISOString().slice(0,10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Markdownファイルをダウンロードしました');
  }

  // ========================================================================
  // Sample Data & Backup Operations
  // ========================================================================
  async loadSampleDataset() {
    const sampleBook = {
      id: 'sample_book_renovation',
      title: 'プロが教える！築古不動産再生と施工管理の勘所',
      author: '建築・不動産実務研究会',
      publishedDate: '2024年4月',
      publisher: '建築技術出版',
      theme: '不動産投資 / 施工管理 / リフォーム',
      description: 'ゼネコン施工管理と建築補償調査で培われた現場目線から、築古物件の修繕リスクと収益化ノウハウを徹底体系化。業者見積もりの見抜き方から地方都市での差別化戦略までを網羅した実践の書。',
      toc: [
        {
          id: 'c1',
          chapterNumber: '第1章',
          chapterTitle: '物件調査と構造のチェックポイント',
          sections: [
            { id: 's1_1', sectionNumber: '1-1', sectionTitle: '基礎・外壁のクラック判定と雨漏りリスク' },
            { id: 's1_2', sectionNumber: '1-2', sectionTitle: '建蔽率・容積率オーバーと法的治癒' },
            { id: 's1_3', sectionNumber: '1-3', sectionTitle: '給排水管の寿命と更新コストのリアル' }
          ]
        },
        {
          id: 'c2',
          chapterNumber: '第2章',
          chapterTitle: '現場監督目線のリフォーム原価管理',
          sections: [
            { id: 's2_1', sectionNumber: '2-1', sectionTitle: '業者見積もりの「一式」を見抜く積算術' },
            { id: 's2_2', sectionNumber: '2-2', sectionTitle: 'DIYでやるべき工事・プロに任せるべき工事' }
          ]
        },
        {
          id: 'c3',
          chapterNumber: '第3章',
          chapterTitle: '賃料設定と入居者に選ばれる差別化',
          sections: [
            { id: 's3_1', sectionNumber: '3-1', sectionTitle: '地方都市でのターゲット層選定と設備投資' },
            { id: 's3_2', sectionNumber: '3-2', sectionTitle: '手残りキャッシュフローを最大化する出口戦略' }
          ]
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this.db.saveBook(sampleBook);

    // Sample Memos
    const sampleMemos = [
      {
        id: 'memo_s1',
        bookId: sampleBook.id,
        sectionId: 's1_1',
        chapterNumber: '第1章',
        sectionTitle: '基礎・外壁のクラック判定と雨漏りリスク',
        text: '0.5ミリ以上の構造クラックは地盤沈下や基礎破断の恐れあり。内見時は基礎巾木のモルタル浮きと鉄筋露出を必ず確認すること。',
        summary: '0.5mm超の構造クラックは建物の安全性に関わるため、モルタル浮きと鉄筋露出の有無を精査する。',
        insight: 'コンサル補償調査でも基礎クラックは補償対象判定の最重要項目。内見時にクラックスケールを持参するだけで数百万の修繕トラップを回避できる。',
        noteAngle: '【現場監督の眼】築古戸建の内見で「基礎のヒビ」を見たら逃げるべきか？補修費用と判定法',
        starred: true,
        createdAt: new Date().toISOString()
      },
      {
        id: 'memo_s2',
        bookId: sampleBook.id,
        sectionId: 's2_1',
        chapterNumber: '第2章',
        sectionTitle: '業者見積もりの「一式」を見抜く積算術',
        text: 'リフォーム業者の「内装工事一式 80万円」に騙されない。平米数と単価（平米1,200円〜）を必ず分解してもらい、材料費と人工を分ける。',
        summary: '見積書の「一式」表記を数量・平米単価にブレイクダウンさせ、原価構造を把握する。',
        insight: 'ゼネコン時代の下請け査定と全く同じ。平米単価の相場頭を持っていれば、相見積もりを取らなくても一発で業者の良し悪しが判別できる。',
        noteAngle: 'リフォーム見積もりの「一式」を許すな！一級建築士が教える見積もり値引き交渉術',
        starred: true,
        createdAt: new Date().toISOString()
      }
    ];

    for (const m of sampleMemos) {
      await this.db.saveMemo(m);
    }

    const books = await this.db.getAllBooks();
    this.renderBookSelectDropdown(books);
    await this.selectBook(sampleBook.id);
    this.closeModal('modalSettings');
    this.showToast('サンプル書籍・メモデータを読み込みました！');
  }

  async exportBackupJSON() {
    const books = await this.db.getAllBooks();
    const memos = await this.db.getAllMemos();
    const backupData = {
      exportedAt: new Date().toISOString(),
      books,
      memos
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `読書note_バックアップ_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('全データをバックアップJSONとして保存しました');
  }

  async importBackupJSON(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.books && Array.isArray(data.books)) {
          for (const b of data.books) await this.db.saveBook(b);
        }
        if (data.memos && Array.isArray(data.memos)) {
          for (const m of data.memos) await this.db.saveMemo(m);
        }
        this.showToast('データを正常に復元しました！');
        await this.loadBooksAndSetCurrent();
        this.closeModal('modalSettings');
      } catch (err) {
        alert('バックアップファイルの読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => {
          console.warn('ServiceWorker registration failed:', err);
        });
      });
    }
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
});
