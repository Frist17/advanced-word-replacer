// ==UserScript==
// @name         Advanced Word Replacer
// @namespace    http://tampermonkey.net
// @version      19.0
// @description  Advanced word replacer with floating UI, cloud sync, whitelist/blacklist site management, multi-language support, and recycle bin
// @author       You
// @match        *://*/*
// @exclude      *://greasyfork.org/*
// @exclude      *://sleazyfork.org/*
// @connect      api.github.com
// @connect      github.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/580034/Advanced%20Word%20Replacer.user.js
// @updateURL https://update.greasyfork.org/scripts/580034/Advanced%20Word%20Replacer.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // ── 1. KONSTANTA & VARIABEL GLOBAL TUNGGAL ──
    const currentHost = window.location.hostname.toLowerCase();
    const HIGHLIGHT_CLASS = 'word-replacer-highlight';
    let observer;
    let replacerTimeout;
    let cloudTitleSyncTimeout;

    let lastProcessedValueMap = new WeakMap();
    const originalTextMap = new WeakMap();

    let toast;
    let toastTimeout;

    // Tembolok in-memory tunggal untuk memecahkan latensi penyimpanan browser
    let cachedToken = "";
    let cachedGistId = "";

    // ── 2. FUNGSI UTILITAS: Pembuat Pola Regex Pintar ──
    function buildRegexPattern(term) {
        if (!term) return "";
        const normalized = term.normalize('NFC').toLowerCase();
        
        const vowelMap = {
            'a': '(?:a|ā|aa)',
            'ā': '(?:a|ā|aa)',
            'e': '(?:e|ē|ee)',
            'ē': '(?:e|ē|ee)',
            'i': '(?:i|ī|ii)',
            'ī': '(?:i|ī|ii)',
            'o': '(?:o|ō|oo|ou)',
            'ō': '(?:o|ō|oo|ou)',
            'u': '(?:u|ū|uu)',
            'ū': '(?:u|ū|uu)'
        };

        const parts = normalized.split(/[\s\-_—–]+/);
        const patternParts = parts.map(part => {
            const chars = part.split('');
            const escapedChars = chars.map(ch => {
                if (vowelMap[ch]) {
                    return vowelMap[ch];
                }
                return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            });
            return escapedChars.join('[\\u200b\\u200c\\u200d\\ufeff]?');
        });
        
        return patternParts.join('[\\s\\-_—–\\u200b\\u200c\\u200d\\ufeff\\u00a0]*');
    }

    function buildBoundaryRegex(term, pattern, flags = 'giu') {
        if (!term) return new RegExp("", flags);
        const normalized = term.normalize('NFC');
        const startsWithWordChar = /^[\p{L}\p{N}]/u.test(normalized);
        const endsWithWordChar = /[\p{L}\p{N}]$/u.test(normalized);
        
        const prefix = startsWithWordChar ? '(?<![\\p{L}\\p{N}])' : '';
        const suffix = endsWithWordChar ? '(?![\\p{L}\\p{N}])' : '';
        
        return new RegExp(prefix + pattern + suffix, flags);
    }

    function unwrapFontTags() {
        if (!document.body) return;
        const fontTags = document.body.querySelectorAll('font');
        if (fontTags.length === 0) return;
        
        fontTags.forEach(font => {
            const parent = font.parentNode;
            if (!parent) return;
            while (font.firstChild) {
                parent.insertBefore(font.firstChild, font);
            }
            parent.removeChild(font);
        });
        document.body.normalize();
    }

    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            const headers = options.headers || {};
            if (options.body && !headers["Content-Type"] && !headers["content-type"]) {
                headers["Content-Type"] = "application/json";
            }
            GM_xmlhttpRequest({
                method: options.method || "GET",
                url: url,
                headers: headers,
                data: options.body || null,
                timeout: 10000, 
                onload: function (response) {
                    const isSuccess = (response.status >= 200 && response.status < 300) || response.status === 302 || response.status === 307;
                    resolve({
                        ok: isSuccess,
                        status: response.status,
                        statusText: response.statusText,
                        json: () => {
                            try {
                                return Promise.resolve(JSON.parse(response.responseText));
                            } catch (e) {
                                return Promise.reject(e);
                            }
                        },
                        text: () => Promise.resolve(response.responseText)
                    });
                },
                ontimeout: function () {
                    reject(new Error("Request timeout"));
                },
                onerror: function (error) {
                    reject(error);
                }
            });
        });
    }

    function extractGistId(str) {
        if (!str) return "";
        const clean = str.trim();
        const match = clean.match(/\/([a-f0-9]{32,})$/i) || clean.match(/^([a-f0-9]{32,})$/i);
        if (match) return match[1];
        const parts = clean.split('/');
        return parts[parts.length - 1].trim();
    }

    // ── 3. MANAJEMEN KREDENSIAL GITHUB & OPERASI GIST LINTAS PERANGKAT ──
    function getGitHubToken() {
        if (cachedToken) return cachedToken;
        const val = GM_getValue("awr_github_token");
        return val ? String(val).trim() : "";
    }

    function getGistId() {
        if (cachedGistId) return cachedGistId;
        const val = GM_getValue("awr_gist_id");
        return val ? String(val).trim() : "";
    }

    function saveGitHubCredentials(token, gistId) {
        cachedToken = token.trim();
        cachedGistId = gistId.trim();
        GM_setValue("awr_github_token", cachedToken);
        GM_setValue("awr_gist_id", cachedGistId);
    }

    async function findExistingGist(token) {
        try {
            const response = await gmFetch(`https://api.github.com/gists?per_page=100&t=${Date.now()}`, {
                method: "GET",
                headers: {
                    "Authorization": `token ${token}`,
                    "Accept": "application/vnd.github.v3+json"
                }
            });
            if (response.ok) {
                const gists = await response.json();
                if (Array.isArray(gists)) {
                    const targetGist = gists.find(gist => gist.files && gist.files["awr_replacer_config.json"]);
                    if (targetGist) {
                        return targetGist.id;
                    }
                }
            }
        } catch (e) {
            console.error("Gagal mendeteksi Gist otomatis:", e);
        }
        return null;
    }

    async function fetchGistDetails(token, gistId) {
        if (!token || !gistId) return null;
        try {
            const response = await gmFetch(`https://api.github.com/gists/${gistId}?t=${Date.now()}`, {
                method: "GET",
                headers: {
                    "Authorization": `token ${token}`,
                    "Accept": "application/vnd.github.v3+json"
                }
            });
            if (response.ok) {
                return await response.json();
            }
        } catch (e) {
            console.error("Gagal mengambil rincian Gist:", e);
        }
        return null;
    }

    async function createGist(token, payload) {
        if (!token) return null;
        try {
            const body = {
                description: "Advanced Word Replacer Cloud Configuration",
                public: false,
                files: {
                    "awr_replacer_config.json": {
                        content: JSON.stringify(payload, null, 2)
                    }
                }
            };
            const response = await gmFetch("https://api.github.com/gists", {
                method: "POST",
                headers: {
                    "Authorization": `token ${token}`,
                    "Accept": "application/vnd.github.v3+json"
                },
                body: JSON.stringify(body)
            });
            if (response.ok) {
                const data = await response.json();
                return data.id;
            }
        } catch (e) {
            console.error("Gagal membuat Gist baru:", e);
        }
        return null;
    }

    async function simpanKeAwan(kamus = null, domains = null, deletedWords = null, forceSnapshot = false) {
        const token = getGitHubToken();
        const gistId = getGistId();
        if (!token || !gistId) return;

        const finalKamus = kamus || getKamus();
        const finalDomains = domains || getTargetDomains();
        const finalBlacklist = getBlacklistDomains();
        const finalFilterMode = getFilterMode();
        const finalNovelTitles = JSON.parse(GM_getValue("awr_novel_titles_v2", "{}"));
        const finalDeletedWords = deletedWords || getDeletedWords();

        const payload = {
            kamus: finalKamus,
            domains: finalDomains,
            blacklist: finalBlacklist,
            filterMode: finalFilterMode,
            novelTitles: finalNovelTitles,
            deletedWords: finalDeletedWords
        };

        const payloadStr = JSON.stringify(payload, null, 2);
        const filesToUpload = {
            "awr_replacer_config.json": {
                content: payloadStr
            }
        };

        if (forceSnapshot) {
            const backupName = getBackupFilename();
            filesToUpload[backupName] = {
                content: payloadStr
            };
        }

        try {
            const response = await gmFetch(`https://api.github.com/gists/${gistId}`, {
                method: "PATCH",
                headers: {
                    "Authorization": `token ${token}`,
                    "Accept": "application/vnd.github.v3+json"
                },
                body: JSON.stringify({
                    files: filesToUpload
                })
            });
            if (response.ok) {
                console.log("Berhasil menyelaraskan data ke Gist.");
            } else {
                console.warn("Gagal menyelaraskan data ke Gist. Status:", response.status);
            }
        } catch (e) {
            console.error("Kesalahan koneksi saat menyimpan ke awan:", e);
        }
    }

    async function sinkronisasiDariAwan(forceUpdate = false) {
        const token = getGitHubToken();
        const gistId = getGistId();
        if (!token || !gistId) return;

        try {
            const details = await fetchGistDetails(token, gistId);
            if (details && details.files && details.files["awr_replacer_config.json"]) {
                let contentText = details.files["awr_replacer_config.json"].content;
                if (!contentText && details.files["awr_replacer_config.json"].raw_url) {
                    const rawRes = await gmFetch(details.files["awr_replacer_config.json"].raw_url);
                    if (rawRes.ok) {
                        contentText = await rawRes.text();
                    }
                }
                if (contentText) {
                    const parsedData = JSON.parse(contentText);
                    if (parsedData) {
                        if (parsedData.kamus) GM_setValue("kamus_kata_v5", JSON.stringify(parsedData.kamus));
                        if (parsedData.domains) GM_setValue("target_domains_v4", JSON.stringify(parsedData.domains));
                        if (parsedData.blacklist) GM_setValue("blacklist_domains_v1", JSON.stringify(parsedData.blacklist));
                        if (parsedData.filterMode) GM_setValue("filter_mode_v1", parsedData.filterMode);
                        if (parsedData.deletedWords) GM_setValue("awr_deleted_words_v1", JSON.stringify(parsedData.deletedWords));
                        if (parsedData.novelTitles) GM_setValue("awr_novel_titles_v2", JSON.stringify(parsedData.novelTitles));
                        
                        if (forceUpdate) {
                            jalankanPengganti(true);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Gagal sinkronisasi data dari awan:", e);
        }
    }

    // ── 4. BACKUP FILENAME GENERATOR & PARSER ──
    function getBackupFilename() {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        const yyyy = now.getFullYear();
        const mm = pad(now.getMonth() + 1);
        const dd = pad(now.getDate());
        const hh = pad(now.getHours());
        const min = pad(now.getMinutes());
        const ss = pad(now.getSeconds());
        return `backup_${yyyy}_${mm}_${dd}_${hh}_${min}_${ss}.json`;
    }

    function parseBackupFilename(filename) {
        const match = filename.match(/^backup_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.json$/);
        if (match) {
            const [_, yyyy, mm, dd, hh, min, ss] = match;
            return `${dd}/${mm}/${yyyy}, ${hh}:${min}:${ss}`;
        }
        return filename;
    }

    // ── 5. MANAJEMEN NOVEL ID & RECYCLE BIN PERSISTEN ──
    function getSyncId() {
        let id = GM_getValue("sync_id_v5");
        if (!id) {
            id = "awr-" + Math.random().toString(36).substring(2, 11) + "-" + Math.random().toString(36).substring(2, 11);
            GM_setValue("sync_id_v5", id);
        }
        return id;
    }

    function getActiveNovelId() {
        return GM_getValue("awr_active_novel_id_v1", "");
    }

    function setActiveNovelId(id) {
        GM_setValue("awr_active_novel_id_v1", id);
    }

    function getDeletedWords() {
        try {
            const val = GM_getValue("awr_deleted_words_v1");
            return val ? JSON.parse(val) : {};
        } catch (e) {
            return {};
        }
    }

    function saveDeletedWords(obj) {
        try {
            GM_setValue("awr_deleted_words_v1", JSON.stringify(obj));
        } catch (e) {
            console.error('Gagal menyimpan kata terhapus', e);
        }
    }

    // ── 6. LOKALISASI MULTI-BAHASA ──
    const TRANSLATIONS = {
        en: {
            flag: "🇺🇸", title: "Advanced Word Replacer", current_site: "Current site:", active: "ACTIVE", off: "OFF", disable: "Disable", enable: "Enable",
            tab_editor: "Editor", tab_terms: "Your Terms", tab_filter: "Filter", tab_recycle: "Recycle Word", tab_setting: "Settings", tab_cloud: "Cloud Manager", tab_config: "Config",
            search_placeholder: "Search old/new words...", select_all: "SELECT ALL", bulk_delete: "Delete ({0})", empty_state: "Dictionary empty / no results found.",
            show_other_terms: "Show Other Novel Terms ({0})", hide_other_terms: "Hide Other Novel Terms ({0})", other_terms_title: "{0} TERMS ({1})",
            original_text: "Original Text ({0})", replacement_text: "Replacement Text ({0})", global_replacer: "All Novels (Global Replacer)", local_replacer: "This Novel Only",
            this_novel_desc: "This term will only apply to this novel.", delete_btn: "Delete", close_btn: "Close", save_btn: "Save", update_btn: "Update",
            suggested_title: "Suggested Misspelled Words:", site_manager: "SITE MANAGER (FILTER)", mode_label: "Mode:", only_whitelist: "Only Whitelist", block_blacklist: "Block Blacklist",
            desc_whitelist: "Script will ONLY run on Whitelist sites listed below.", desc_blacklist: "Script will run on ALL sites, EXCEPT those listed in Blacklist below.",
            new_whitelist_placeholder: "New whitelist domain...", new_blacklist_placeholder: "New blacklist domain...", script_settings: "REPLACER SCRIPT CONFIG",
            blue_highlight: "Blue Highlight", blue_highlight_desc: "Bold and color replaced words in blue", restore_defaults: "Restore Defaults", restore_desc: "Delete custom data and reset to default", reset_data: "Reset Data",
            toast_removed_whitelist: "Site removed from Whitelist: {0}", toast_added_whitelist: "Site added to Whitelist: {0}", toast_added_blacklist: "Site added to Blacklist: {0}", toast_removed_blacklist: "Site removed from Blacklist: {0}",
            toast_deleted: "Rule '{0}' moved to Recycle Word", toast_updated: "Word '{0}' updated", toast_added: "Word '{0}' added", toast_filter_mode: "Filter mode changed to {0}",
            toast_whitelist_deleted: "Whitelist {0} deleted", toast_blacklist_deleted: "Blacklist {0} deleted", toast_copied: "Sync Key copied to clipboard!",
            toast_sync_connecting: "Connecting & syncing...", toast_sync_success: "Sync connection successful!", toast_reset_success: "All settings and words successfully reset!",
            alert_both_fields: "Both word fields are required!", alert_already_registered: "Site is already registered!", alert_enter_key: "Please enter a Sync Key first!",
            alert_same_key: "Sync Key is identical to this device!", alert_overwrite_confirm: "Connecting will overwrite local data with cloud data. Continue?", alert_bulk_delete_confirm: "Are you sure you want to move {0} selected rules to Recycle Word?",
            deleted_words_banner: "Deleted {0} words", undo_btn: "Undo", toast_restored: "Successfully restored {0} words!", sure_btn: "Sure?", yakin_btn: "Sure?", yakin_reset: "⚠️ SURE RESET? CLICK AGAIN",
            replaced_from: "From {0}", replaced_to: "To {0}", word_salah_placeholder: "Example: man", word_benar_placeholder: "Example: man(woman)",

            undo_tooltip: "Undo / Restore", confirm_undo_bulk: "Are you sure you want to restore {0} selected rules?", confirm_delete_perm_bulk: "Are you sure you want to permanently delete {0} selected rules?",
            toast_undone: "Word '{0}' successfully restored!", toast_deleted_perm: "Word '{0}' permanently deleted!", toast_bulk_undone: "Successfully restored {0} words!", toast_bulk_deleted_perm: "Successfully permanently deleted {0} words!",
            bulk_undo: "Restore ({0})", bulk_delete_perm: "Delete Perm ({0})",

            cloud_storage_status: "Cloud Storage Status", baskets_used: "Baskets (Configs) Used", used_of_max: "{0} of {1} Baskets", load_config: "Stored Configurations",
            loading_cloud_data: "Connecting to GitHub Gist...", no_backups_found: "No backups found on cloud.", current_active: "Active Gist State", btn_load: "Load",
            toast_config_loaded: "Configuration restored successfully!", toast_config_deleted: "Gist disconnected!", toast_github_connected: "Connected to GitHub Gist successfully!",
            toast_account_switched: "Logged out from current GitHub account.", toast_revision_restored: "Version '{0}' restored successfully!"
        },
        id: {
            flag: "🇮🇩", title: "Advanced Word Replacer", current_site: "Situs saat ini:", active: "AKTIF", off: "OFF", disable: "Matikan", enable: "Aktifkan",
            tab_editor: "Editor", tab_terms: "Your Terms", tab_filter: "Filter", tab_recycle: "Recycle Word", tab_setting: "Kelola", tab_cloud: "Cloud Manager", tab_config: "Config",
            search_placeholder: "Cari kata lama/baru...", select_all: "PILIH SEMUA", bulk_delete: "Hapus ({0})", empty_state: "Kamus kosong / tidak ada hasil.",
            show_other_terms: "Show Other Novel Terms ({0})", hide_other_terms: "Hide Other Novel Terms ({0})", other_terms_title: "TERMS {0} ({1})",
            original_text: "Original Text ({0})", replacement_text: "Replacement Text ({0})", global_replacer: "All Novels (Global Replacer)", local_replacer: "This Novel Only",
            this_novel_desc: "This term will only apply to this novel.", delete_btn: "Delete", close_btn: "Close", save_btn: "Save", update_btn: "Update",
            suggested_title: "Rekomendasi Kata Salah:", site_manager: "SITUS MANAJER (FILTER)", mode_label: "Mode:", only_whitelist: "Only Whitelist", block_blacklist: "Block Blacklist",
            desc_whitelist: "Skrip HANYA akan berjalan pada situs yang ada di daftar Whitelist di bawah ini.", desc_blacklist: "Skrip akan berjalan di SEMUA situs, KECUALI situs yang terdaftar di daftar Blokir (Blacklist) di bawah ini.",
            new_whitelist_placeholder: "Domain whitelist baru...", new_blacklist_placeholder: "Domain blokir baru...", script_settings: "PENGATURAN SKRIP REPLACER (CONFIG)",
            blue_highlight: "Highlight Biru", blue_highlight_desc: "Berikan warna biru tebal pada kata yang berhasil diganti", restore_defaults: "Kembalikan Default", restore_desc: "Hapus data kustom dan reset ke bawaan", reset_data: "Reset Data",
            toast_removed_whitelist: "Situs dihapus dari Whitelist: {0}", toast_added_whitelist: "Situs ditambahkan ke Whitelist: {0}", toast_added_blacklist: "Situs ditambahkan ke daftar Blokir: {0}", toast_removed_blacklist: "Situs dihapus dari daftar Blokir: {0}",
            toast_deleted: "Aturan '{0}' dipindahkan ke Recycle Word", toast_updated: "Kata '{0}' diperbarui", toast_added: "Kata '{0}' ditambahkan", toast_filter_mode: "Mode filter diubah ke {0}",
            toast_whitelist_deleted: "Whitelist {0} dihapus", toast_blacklist_deleted: "Blokir {0} dihapus", toast_copied: "Kunci Sinkronisasi disalin ke clipboard!",
            toast_sync_connecting: "Menghubungkan & menyinkronkan...", toast_sync_success: "Koneksi sinkronisasi berhasil!", toast_reset_success: "Semua setelan dan kata berhasil di-reset!",
            alert_both_fields: "Kedua kolom kata wajib diisi!", alert_already_registered: "Situs sudah terdaftar!", alert_enter_key: "Silakan masukkan Kunci Sinkronisasi terlebih dahulu!",
            alert_same_key: "Kunci Sinkronisasi sama dengan perangkat ini!", alert_overwrite_confirm: "Menghubungkan perangkat akan menimpa data lokal dengan data awan baru (jika ada). Lanjutkan?", alert_bulk_delete_confirm: "Yakin ingin memindahkan {0} aturan kata terpilih ke Recycle Word?",
            deleted_words_banner: "Terhapus {0} kata", undo_btn: "Urungkan", toast_restored: "Berhasil mengembalikan {0} kata!", sure_btn: "Yakin?", yakin_btn: "Yakin?", yakin_reset: "⚠️ YAKIN RESET? KLIK LAGI",
            replaced_from: "From {0}", replaced_to: "To {0}", word_salah_placeholder: "Contoh: pria", word_benar_placeholder: "Contoh: pria(wanita)",

            undo_tooltip: "Urungkan / Kembalikan", confirm_undo_bulk: "Apakah Anda yakin ingin mengembalikan {0} kata terpilih?", confirm_delete_perm_bulk: "Apakah Anda yakin ingin menghapus permanen {0} kata terpilih?",
            toast_undone: "Kata '{0}' berhasil dikembalikan!", toast_deleted_perm: "Kata '{0}' berhasil dihapus permanen!", toast_bulk_undone: "Berhasil mengembalikan {0} kata!", toast_bulk_deleted_perm: "Berhasil menghapus permanen {0} kata!",
            bulk_undo: "Urungkan ({0})", bulk_delete_perm: "Hapus Permanen ({0})",

            cloud_storage_status: "Status Penyimpanan Cloud", baskets_used: "Basket (Config) Terpakai", used_of_max: "{0} dari {1} Basket", load_config: "Daftar Konfigurasi Tersimpan",
            loading_cloud_data: "Menghubungkan ke GitHub Gist...", no_backups_found: "Tidak ada konfigurasi tersimpan di Gist ini.", current_active: "Status Gist Aktif", btn_load: "Muat",
            toast_config_loaded: "Konfigurasi berhasil dipulihkan!", toast_config_deleted: "Gist diputuskan!", toast_github_connected: "Berhasil terhubung ke GitHub Gist!",
            toast_account_switched: "Berhasil keluar dari akun GitHub.", toast_revision_restored: "Versi '{0}' berhasil dipulihkan!"
        }
    };

    function getLang() { return GM_getValue("awr_lang_v1", "en"); }
    function saveLang(langCode) { GM_setValue("awr_lang_v1", langCode); }

    function t(key, ...args) {
        const lang = getLang();
        const dict = TRANSLATIONS[lang] || TRANSLATIONS["en"];
        const template = dict[key] || TRANSLATIONS["en"][key] || "";
        if (!template) return key;
        return template.replace(/{(\d+)}/g, (match, index) => {
            return typeof args[index] !== 'undefined' ? args[index] : match;
        });
    }

    function panggilToast(pesan, tipe = 'success') {
        if (!toast) return;
        toast.innerHTML = '';

        const textSpan = document.createElement('span');
        textSpan.textContent = pesan;
        toast.appendChild(textSpan);

        toast.className = 'replacer-toast show ' + tipe;
        if (toastTimeout) clearTimeout(toastTimeout);

        toastTimeout = setTimeout(() => {
            toast.className = 'replacer-toast';
        }, 2500);
    }

    // ── 7. PENANGANAN GLOSARI & EKSTRAKSI DOMAIN NOVEL ──
    function isInsideNativeGlossary(el) {
        if (!el) return false;
        const element = el.nodeType === Node.TEXT_NODE ? el.parentElement : el;
        if (!element) return false;
        return !!element.closest('.wtr-glossary, [data-term-id], [data-term], .glossary-term, .term, .translation-term, [data-translation], .term-tooltip, .wtr-term, [data-wtr-term]');
    }

    function getNovelBaseDomain(host) {
        if (!host) return '';
        let clean = host.toLowerCase().trim();
        let parts = clean.split('.');

        if (parts.length <= 2) {
            return clean;
        }

        const chapterPrefixRegex = /^(www|m|ch(apter)?-\d+|c\d+|vol(ume)?-\d+|\d+|vol(ume)?-\d+-ch(apter)?-\d+|ch(apter)?-\d+-vol(ume)?-\d+)$/i;

        while (parts.length > 2 && chapterPrefixRegex.test(parts[0])) {
            parts.shift();
        }

        return parts.join('.');
    }

    function getCachedNovelTitle(novelId) {
        if (!novelId) return "";
        try {
            const cacheVal = GM_getValue("awr_novel_titles_v2", "{}");
            const cache = typeof cacheVal === "string" ? JSON.parse(cacheVal) : cacheVal;
            return cache[novelId] || "";
        } catch (e) {
            return "";
        }
    }

    function triggerLazyTitleSync() {
        if (cloudTitleSyncTimeout) clearTimeout(cloudTitleSyncTimeout);
        cloudTitleSyncTimeout = setTimeout(() => {
            simpanKeAwan();
        }, 5000);
    }

    function saveCachedNovelTitle(novelId, title) {
        if (!novelId || !title) return;
        try {
            const cacheVal = GM_getValue("awr_novel_titles_v2", "{}");
            const cache = typeof cacheVal === "string" ? JSON.parse(cacheVal) : cacheVal;
            if (cache[novelId] !== title) {
                cache[novelId] = title;
                GM_setValue("awr_novel_titles_v2", JSON.stringify(cache));
                triggerLazyTitleSync();
            }
        } catch (e) {
            console.error("Gagal menyimpan cache judul", e);
        }
    }

    function cleanTitleText(str) {
        if (!str) return "";

        let parts = str.split(/\s+[-|–]\s+|\s*\|\s*/).map(p => p.trim()).filter(Boolean);

        let novelParts = parts.filter(p => {
            let pLower = p.toLowerCase().trim();
            if (/^(chapter|ch|chap|volume|vol|bab|b\.)\.?\s*\d+/i.test(p)) return false;
            if (/^\d+$/.test(p)) return false;
            if (pLower === 'wtr-lab' || pLower === 'wtr' || pLower === 'lab' || pLower === 'wtr lab' || pLower === 'mtl' || pLower === 'lightnovel') return false;
            if (/^(webnovel|wuxiaworld|novelupdates|qidian|readlightnovel|novelhall|boxnovel|royalroad|scribblehub|wattpad|story|novel|book|b|lightnovel|fiction|series)$/i.test(p)) return false;
            return true;
        });

        if (novelParts.length > 0) {
            let t = novelParts[0];
            t = t.replace(/^\s*Read\s+/i, "");
            t = t.replace(/\s+RAW\s+(Indonesia|English|Spanish|German|Japanese)?\s+Translation\s*$/i, "");
            t = t.replace(/\s+(Indonesia|English|Spanish|German|Japanese)?\s+Translation\s*$/i, "");
            t = t.replace(/\s+RAW\s*$/i, "");
            t = t.replace(/\s+(online|free|novel|chapter|b\.)\s*$/i, "");
            return t.trim();
        }
        return "";
    }

    function extractNovelTitleFromDOM() {
        const metaSelectors = [
            'meta[property="og:novel:book_name"]',
            'meta[name="novel:book_name"]',
            'meta[name="book_name"]',
            'meta[property="og:title"]'
        ];
        for (const sel of metaSelectors) {
            const el = document.querySelector(sel);
            if (el && el.getAttribute('content')) {
                const clean = cleanTitleText(el.getAttribute('content'));
                if (clean && clean.length > 2) return clean;
            }
        }

        const breadcrumbs = document.querySelectorAll('.breadcrumb-item a, .breadcrumb a, [class*="breadcrumb"] a, .breadcrumbs a');
        for (const a of breadcrumbs) {
            const text = a.textContent.trim();
            const href = a.getAttribute('href') || "";
            if (text && href && (href.includes('/novel/') || href.includes('/book/') || href.includes('/story/') || href.includes('/fiction/') || href.includes('/series/'))) {
                const clean = cleanTitleText(text);
                if (clean && clean.length > 2) return clean;
            }
        }

        const classPatterns = [
            '.book-title', '.novel-title', '.story-title', '.series-title',
            '.series-name', '.seriestitle', '.fic-title', '.fic_title',
            '.book-name', '.novel-name', '.title-book', 'h1'
        ];
        for (const sel of classPatterns) {
            const el = document.querySelector(sel);
            if (el) {
                if (el.closest('header, .header, #header, .navbar, .nav, .logo, #logo, footer, .footer, #footer')) {
                    continue;
                }
                if (el.textContent.trim()) {
                    const clean = cleanTitleText(el.textContent);
                    if (clean && clean.length > 2) return clean;
                }
            }
        }

        return cleanTitleText(document.title);
    }

    function getNovelContext() {
        const url = window.location.href;
        const host = window.location.hostname.toLowerCase();
        let novelId = '';
        let novelTitle = '';
        let novelUrl = url;

        const storyMatch = url.match(/(https?:\/\/[^\/]+.*?\/story\/\d+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/book\/.*?_\d+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/book\/\d+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/novel\/\d+\/[^/]+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/novel\/\d+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/novel\/[^/]+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/fiction\/\d+)/i) ||
                           url.match(/(https?:\/\/[^\/]+.*?\/series\/\d+)/i);

        if (storyMatch) {
            novelId = storyMatch[1].toLowerCase().trim();
        } else {
            const pathParts = window.location.pathname.split('/').filter(Boolean);
            const idx = pathParts.findIndex(p => ['novel', 'series', 'book', 'b', 'story', 'fiction', 'f'].includes(p.toLowerCase()));
            if (idx !== -1 && pathParts[idx + 1]) {
                const slug = pathParts[idx + 1];
                novelId = `${host}_novel_${slug}`;
            } else if (pathParts.length > 0) {
                const slug = pathParts[0];
                novelId = `${host}_novel_${slug}`;
            } else {
                novelId = host;
            }
        }

        novelTitle = getCachedNovelTitle(novelId);

        if (!novelTitle) {
            const extracted = extractNovelTitleFromDOM();
            if (extracted && extracted.length > 2) {
                novelTitle = extracted;
                saveCachedNovelTitle(novelId, novelTitle);
            }
        }

        if (!novelTitle) {
            const lastPart = novelId.split('/').pop() || novelId.split('_').pop();
            novelTitle = lastPart.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }

        return {
            id: novelId,
            title: novelTitle,
            url: novelUrl
        };
    }

    // ── 8. PENYIMPANAN KAMUS LOKAL & MODE FILTER DOMAIN ──
    function getKamus() {
        try {
            let val = GM_getValue("kamus_kata_v5");
            let kamus = val ? JSON.parse(val) : null;

            if (kamus) {
                let cleaned = {};
                let hasChanges = false;
                for (const key in kamus) {
                    const normalizedKey = key.normalize('NFC').trim().toLowerCase();
                    if (key !== normalizedKey) {
                        hasChanges = true;
                    }
                    if (!cleaned[normalizedKey]) {
                        cleaned[normalizedKey] = kamus[key];
                    }
                }
                if (hasChanges) {
                    GM_setValue("kamus_kata_v5", JSON.stringify(cleaned));
                    kamus = cleaned;
                }
                return kamus;
            }

            const v4Val = GM_getValue("kamus_kata_v4");
            if (v4Val) {
                const v4 = JSON.parse(v4Val);
                const v5 = {};
                for (const key in v4) {
                    const normalizedKey = key.normalize('NFC').trim().toLowerCase();
                    v5[normalizedKey] = {
                        to: v4[key],
                        global: true,
                        domain: getNovelBaseDomain(currentHost)
                    };
                }
                GM_setValue("kamus_kata_v5", JSON.stringify(v5));
                return v5;
            }

            const defaultKamus = {
                "silahkan": { to: "silakan", global: true, domain: "wikipedia.org" },
                "wikipedia": { to: "Ensiklopedia Bebas", global: true, domain: "wikipedia.org" },
                "salah": { to: "keliru", global: true, domain: "detik.com" }
            };
            GM_setValue("kamus_kata_v5", JSON.stringify(defaultKamus));
            return defaultKamus;
        } catch (e) {
            return {};
        }
    }

    function saveKamus(obj) {
        try {
            GM_setValue("kamus_kata_v5", JSON.stringify(obj));
        } catch (e) { console.error('Gagal menyimpan kamus v5', e); }
    }

    function getTargetDomains() {
        try {
            const val = GM_getValue("target_domains_v4");
            return val ? JSON.parse(val) : ["wikipedia.org", "detik.com", "myblog.id"];
        } catch (e) {
            return ["wikipedia.org", "detik.com", "myblog.id"];
        }
    }

    function saveTargetDomains(domains) {
        try {
            GM_setValue("target_domains_v4", JSON.stringify(domains));
        } catch (e) {
            console.error("Gagal menyimpan domain whitelist", e);
        }
    }

    function getBlacklistDomains() {
        try {
            const val = GM_getValue("blacklist_domains_v1");
            return val ? JSON.parse(val) : ["google.com", "facebook.com", "youtube.com"];
        } catch (e) {
            return ["google.com", "facebook.com", "youtube.com"];
        }
    }

    function saveBlacklistDomains(domains) {
        try {
            GM_setValue("blacklist_domains_v1", JSON.stringify(domains));
        } catch (e) {
            console.error("Gagal menyimpan domain blacklist", e);
        }
    }

    function getFilterMode() {
        return GM_getValue("filter_mode_v1", "whitelist");
    }

    function saveFilterMode(mode) {
        GM_setValue("filter_mode_v1", mode);
    }

    function getKamusAktif() {
        const kamus = getKamus();
        const aktif = {};
        const currentNovel = getNovelContext();
        const pageBaseDomain = getNovelBaseDomain(currentHost);
        const activeNovelId = getActiveNovelId();

        const targetActiveId = activeNovelId ? activeNovelId : currentNovel.id;

        for (const salah in kamus) {
            const item = kamus[salah];
            const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');

            if (item && typeof item === 'object') {
                if (item.global) {
                    aktif[salah] = toVal;
                } else if (item.novelId) {
                    if (item.novelId === targetActiveId) {
                        aktif[salah] = toVal;
                    }
                } else {
                    if (!activeNovelId) {
                        const termBaseDomain = getNovelBaseDomain(item.domain);
                        const isLocal = termBaseDomain === pageBaseDomain || (termBaseDomain && pageBaseDomain.endsWith('.' + termBaseDomain));
                        if (isLocal) {
                            aktif[salah] = toVal;
                        }
                    }
                }
            } else if (typeof item === 'string') {
                aktif[salah] = item;
            }
        }
        return aktif;
    }

    function getHighlightAktif() {
        try {
            const val = GM_getValue("highlight_aktif_v4");
            return val !== undefined ? val : true;
        } catch (e) {
            return true;
        }
    }

    function saveHighlightAktif(val) {
        try {
            GM_setValue("highlight_aktif_v4", val);
        } catch (e) { console.error('Gagal menyimpan status highlight', e); }
    }

    function isDomainAllowed() {
        const mode = getFilterMode();
        const pageBaseDomain = getNovelBaseDomain(currentHost);

        if (mode === "whitelist") {
            const whitelist = getTargetDomains();
            return whitelist.some(d => {
                const cleanDomain = getNovelBaseDomain(d.trim().toLowerCase());
                if (!cleanDomain) return false;
                return pageBaseDomain === cleanDomain || pageBaseDomain.endsWith('.' + cleanDomain);
            });
        } else {
            const blacklist = getBlacklistDomains();
            const isBlacklisted = blacklist.some(d => {
                const cleanDomain = getNovelBaseDomain(d.trim().toLowerCase());
                if (!cleanDomain) return false;
                return pageBaseDomain === cleanDomain || pageBaseDomain.endsWith('.' + cleanDomain);
            });
            return !isBlacklisted;
        }
    }

    // ── 9. PROSES HIGHLIGHT & PENGGANTIAN TEKS DOM ──
    const styleEl = document.createElement('style');
    styleEl.textContent = [
        '.word-replacer-highlight {',
        '  color: #3b82f6 !important;',
        '  background-color: transparent !important;',
        '  font-weight: bold !important;',
        '  outline: none !important;',
        '  border-radius: 0 !important;',
        '  padding: 0 !important;',
        '  transition: color 0.2s ease !important;',
        '  cursor: pointer !important;',
        '}',
        '.word-replacer-highlight:hover {',
        '  color: #60a5fa !important;',
        '  text-decoration: underline !important;',
        '}',
        '.term-badge {',
        '  font-size: 9px !important;',
        '  padding: 1px 7px !important;',
        '  border-radius: 8px !important;',
        '  font-weight: bold !important;',
        '  display: inline-block !important;',
        '  margin-top: 4px !important;',
        '  width: fit-content !important;',
        '}',
        '.term-badge.global {',
        '  background: rgba(59, 130, 246, 0.15) !important;',
        '  color: #60a5fa !important;',
        '  border: 1px solid rgba(59, 130, 246, 0.3) !important;',
        '}',
        '.term-badge.local {',
        '  background: rgba(245, 158, 11, 0.15) !important;',
        '  color: #fbbf24 !important;',
        '  border: 1px solid rgba(245, 158, 11, 0.3) !important;',
        '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(styleEl);

    function hapusSemuaHighlight() {
        const spans = document.querySelectorAll('.' + HIGHLIGHT_CLASS);
        const parentsToNormalize = new Set();

        spans.forEach(span => {
            const parent = span.parentNode;
            if (!parent) return;

            const originalText = span.getAttribute('data-original') || span.textContent;
            const textNode = document.createTextNode(originalText);
            parent.replaceChild(textNode, span);
            parentsToNormalize.add(parent);
        });

        parentsToNormalize.forEach(parent => parent.normalize());
    }

    function restoreAllDirectReplacements() {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );
        let node;
        while ((node = walker.nextNode())) {
            if (originalTextMap.has(node)) {
                node.nodeValue = originalTextMap.get(node);
                originalTextMap.delete(node);
            }
        }
    }

    function jalankanPengganti(forceRebuild = false) {
        if (observer) observer.disconnect();

        if (!isDomainAllowed()) {
            hapusSemuaHighlight();
            restoreAllDirectReplacements();
            lastProcessedValueMap = new WeakMap();
            if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            return;
        }

        try {
            unwrapFontTags();
        } catch (e) {
            console.warn("Gagal melakukan unwrap tag terjemahan:", e);
        }

        if (forceRebuild) {
            hapusSemuaHighlight();
            restoreAllDirectReplacements();
            lastProcessedValueMap = new WeakMap();
        }

        const kamus = getKamusAktif();
        const highlightOn = getHighlightAktif();

        const textNodes = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    const textValue = node.nodeValue.normalize('NFC');
                    if (lastProcessedValueMap.has(node) && lastProcessedValueMap.get(node) === textValue) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    const tag = node.parentElement && node.parentElement.tagName;
                    if (!tag) return NodeFilter.FILTER_REJECT;
                    if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','BUTTON'].includes(tag)) return NodeFilter.FILTER_REJECT;
                    if (node.parentElement.closest('#word-replacer-host')) return NodeFilter.FILTER_REJECT;

                    if (node.parentElement.classList.contains(HIGHLIGHT_CLASS)) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    return NodeFilter.FILTER_ACCEPT;
                }
            },
            false
        );

        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }

        textNodes.forEach(node => {
            if (!node.parentNode) return;

            const teksAsli = node.nodeValue.normalize('NFC');
            lastProcessedValueMap.set(node, teksAsli);

            if (originalTextMap.has(node)) {
                node.nodeValue = originalTextMap.get(node).normalize('NFC');
            }

            let adaPerubahan = false;

            for (const salah in kamus) {
                const pattern = buildRegexPattern(salah);
                const regexBoundary = buildBoundaryRegex(salah, pattern, 'giu');
                if (regexBoundary.test(teksAsli)) {
                    adaPerubahan = true;
                    break;
                }
            }

            if (!adaPerubahan) {
                originalTextMap.delete(node);
                return;
            }

            if (!originalTextMap.has(node)) {
                originalTextMap.set(node, teksAsli);
            }

            const diDalamGlosari = isInsideNativeGlossary(node);
            const actualHighlightOn = highlightOn && !diDalamGlosari;

            if (!actualHighlightOn) {
                let teksBaru = teksAsli;
                for (const salah in kamus) {
                    const pattern = buildRegexPattern(salah);
                    const regexBoundary = buildBoundaryRegex(salah, pattern, 'giu');
                    teksBaru = teksBaru.replace(regexBoundary, kamus[salah]);
                }
                node.nodeValue = teksBaru;
                lastProcessedValueMap.set(node, teksBaru);
            } else {
                const allKeysPattern = Object.keys(kamus).map(k => {
                    const pattern = buildRegexPattern(k);
                    const startsWithWordChar = /^[\p{L}\p{N}]/u.test(k.normalize('NFC'));
                    const endsWithWordChar = /[\p{L}\p{N}]$/u.test(k.normalize('NFC'));
                    
                    const prefix = startsWithWordChar ? '(?<![\\p{L}\\p{N}])' : '';
                    const suffix = endsWithWordChar ? '(?![\\p{L}\\p{N}])' : '';
                    
                    return prefix + pattern + suffix;
                });
                if (allKeysPattern.length === 0) return;

                const regexGabungan = new RegExp('(' + allKeysPattern.join('|') + ')', 'giu');

                const fragment = document.createDocumentFragment();
                let lastIndex = 0;
                let match;

                regexGabungan.lastIndex = 0;
                while ((match = regexGabungan.exec(teksAsli)) !== null) {
                    if (match.index > lastIndex) {
                        const segmentText = teksAsli.slice(lastIndex, match.index);
                        const segmentNode = document.createTextNode(segmentText);
                        lastProcessedValueMap.set(segmentNode, segmentText);
                        fragment.appendChild(segmentNode);
                    }

                    let penggantinya = match[0];
                    for (const salah in kamus) {
                        const pattern = buildRegexPattern(salah);
                        const rx = new RegExp('^' + pattern + '$', 'iu');
                        if (rx.test(match[0])) {
                            penggantinya = kamus[salah];
                            break;
                        }
                    }

                    const span = document.createElement('span');
                    span.className = HIGHLIGHT_CLASS;
                    span.textContent = penggantinya;
                    span.setAttribute('data-original', match[0]);
                    span.title = 'Diganti dari: "' + match[0] + '"';

                    span.childNodes.forEach(child => {
                        lastProcessedValueMap.set(child, child.nodeValue);
                    });
                    fragment.appendChild(span);

                    lastIndex = match.index + match[0].length;
                }

                if (lastIndex < teksAsli.length) {
                    const segmentText = teksAsli.slice(lastIndex);
                    const lastSegmentNode = document.createTextNode(segmentText);
                    lastProcessedValueMap.set(lastSegmentNode, segmentText);
                    fragment.appendChild(lastSegmentNode);
                }

                try {
                    node.parentNode.replaceChild(fragment, node);
                } catch (e) {
                    console.warn('Gagal memproses penggantian elemen:', e);
                }
            }
        });

        if (observer && document.body) {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
    }

    // ── 10. PEMBUATAN FLOATING UI (SHADOW DOM) ──
    function buatFloatingUI() {
        if (document.getElementById('word-replacer-host')) return;

        let startX = 0;
        let startY = 0;
        let tabAktif = 'daftar';
        let settingSubTab = 'filter';
        let subjekEdit = null;
        let showOtherTerms = false;

        const hostElement = document.createElement('div');
        hostElement.id = 'word-replacer-host';
        hostElement.setAttribute('style', 'position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 999999999 !important; pointer-events: none !important;');
        document.body.appendChild(hostElement);

        const shadow = hostElement.attachShadow({ mode: 'open' });

        ['keydown', 'keyup', 'keypress'].forEach(eventType => {
            shadow.addEventListener(eventType, (e) => {
                const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
                if (tag === 'input' || tag === 'textarea') {
                    e.stopPropagation();
                }
            }, { capture: true });
        });

        shadow.addEventListener('click', (e) => {
            const langDropdown = shadow.querySelector('.lang-dropdown-menu');
            if (langDropdown && langDropdown.classList.contains('show')) {
                if (!e.target.closest('.lang-dropdown-container')) {
                    langDropdown.classList.remove('show');
                }
            }

            const groupMenus = shadow.querySelectorAll('.group-dropdown-menu');
            groupMenus.forEach(menu => {
                if (menu.classList.contains('show')) {
                    const container = menu.closest('.group-menu-container');
                    if (!container || !container.contains(e.target)) {
                        menu.classList.remove('show');
                    }
                }
            });
        });

        const style = document.createElement('style');
        style.textContent = [
            '/* Main Panel & Wrapper */',
            '.replacer-wrapper {',
            '  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;',
            '  color: #f1f5f9 !important;',
            '}',
            '.replacer-panel {',
            '  position: fixed !important;',
            '  bottom: 0 !important;',
            '  left: 0 !important;',
            '  z-index: 999999999 !important;',
            '  width: 380px !important;',
            '  height: 60vh !important;',
            '  background: #0f172a !important; /* Deep dark slate background */',
            '  border-right: 1px solid #334155 !important;',
            '  border-top: 1px solid #334155 !important;',
            '  border-top-right-radius: 16px !important;',
            '  border-top-left-radius: 16px !important;',
            '  box-shadow: 0 -10px 25px -5px rgba(0, 0, 0, 0.6) !important;',
            '  display: flex !important;',
            '  flex-direction: column !important;',
            '  overflow: hidden !important;',
            '  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;',
            '  transform: translateX(0) !important;',
            '  pointer-events: auto !important;',
            '}',
            '.replacer-panel.hidden {',
            '  transform: translateX(-100%) !important;',
            '  pointer-events: none !important;',
            '}',
            '/* Launcher Button */',
            '.replacer-launcher {',
            '  position: fixed !important;',
            '  bottom: 24px !important;',
            '  left: 24px !important;',
            '  z-index: 100000000 !important;',
            '  background: #1e293b !important;',
            '  color: #f8fafc !important;',
            '  border: 1px solid #475569 !important;',
            '  border-radius: 9999px !important;',
            '  padding: 10px 18px !important;',
            '  font-size: 13px !important;',
            '  font-weight: 700 !important;',
            '  cursor: pointer !important;',
            '  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4) !important;',
            '  display: flex !important;',
            '  align-items: center !important;',
            '  gap: 8px !important;',
            '  transition: all 0.2s ease !important;',
            '  pointer-events: auto !important;',
            '}',
            '.replacer-launcher:hover {',
            '  transform: scale(1.05) !important;',
            '  background: #334155 !important;',
            '  border-color: #3b82f6 !important;',
            '}',
            '/* Header & Status */',
            '.replacer-header {',
            '  background: #1e293b !important;',
            '  color: #f8fafc !important;',
            '  padding: 14px 16px !important;',
            '  display: flex !important;',
            '  flex-direction: column !important;',
            '  border-bottom: 1px solid #334155 !important;',
            '}',
            '.replacer-title {',
            '  font-size: 15px !important;',
            '  font-weight: 800 !important;',
            '  letter-spacing: 0.05em !important;',
            '  color: #f8fafc !important;',
            '}',
            '.replacer-close {',
            '  background: none !important;',
            '  border: none !important;',
            '  color: #94a3b8 !important;',
            '  font-size: 18px !important;',
            '  cursor: pointer !important;',
            '  padding: 2px !important;',
            '  display: flex !important;',
            '  align-items: center !important;',
            '}',
            '.replacer-close:hover {',
            '  color: #ffffff !important;',
            '}',
            '/* Visualisasi Status Header Super Rapi */',
            '.replacer-host-status {',
            '  background: #0f172a !important;',
            '  border: 1px solid #334155 !important;',
            '  border-radius: 12px !important;',
            '  padding: 10px 14px !important;',
            '  margin-top: 10px !important;',
            '  display: flex !important;',
            '  justify-content: space-between !important;',
            '  align-items: center !important;',
            '  gap: 12px !important;',
            '  font-size: 11px !important;',
            '}',
            '.host-info {',
            '  display: flex !important;',
            '  flex-direction: column !important;',
            '  gap: 2px !important;',
            '  min-width: 0 !important;',
            '  flex: 1 !important;',
            '}',
            '.host-label {',
            '  color: #64748b !important;',
            '  font-size: 9px !important;',
            '  font-weight: 800 !important;',
            '  text-transform: uppercase !important;',
            '  letter-spacing: 0.05em !important;',
            '}',
            '.host-name {',
            '  font-family: monospace !important;',
            '  font-weight: 700 !important;',
            '  color: #cbd5e1 !important;',
            '  font-size: 11px !important;',
            '  white-space: nowrap !important;',
            '  overflow: hidden !important;',
            '  text-overflow: ellipsis !important;',
            '}',
            '.status-actions {',
            '  display: flex !important;',
            '  align-items: center !important;',
            '  gap: 8px !important;',
            '  flex-shrink: 0 !important;',
            '}',
            '.status-badge {',
            '  padding: 4px 10px !important;',
            '  border-radius: 9999px !important;',
            '  font-size: 10px !important;',
            '  font-weight: 700 !important;',
            '  display: inline-flex !important;',
            '  align-items: center !important;',
            '  gap: 6px !important;',
            '}',
            '.status-badge.active {',
            '  background: rgba(16, 185, 129, 0.1) !important;',
            '  color: #34d399 !important;',
            '  border: 1px solid rgba(16, 185, 129, 0.3) !important;',
            '}',
            '.status-badge.inactive {',
            '  background: rgba(239, 68, 68, 0.1) !important;',
            '  color: #f87171 !important;',
            '  border: 1px solid rgba(239, 68, 68, 0.3) !important;',
            '}',
            '.status-indicator {',
            '  width: 6px !important;',
            '  height: 6px !important;',
            '  border-radius: 50% !important;',
            '  display: inline-block !important;',
            '}',
            '.status-indicator.active { background-color: #10b981 !important; }',
            '.status-indicator.inactive { background-color: #ef4444 !important; }',
            '.toggle-btn {',
            '  background: #1e293b !important;',
            '  border: 1px solid #475569 !important;',
            '  color: #cbd5e1 !important;',
            '  padding: 5px 12px !important;',
            '  border-radius: 8px !important;',
            '  font-size: 11px !important;',
            '  font-weight: 600 !important;',
            '  cursor: pointer !important;',
            '  transition: all 0.2s ease !important;',
            '}',
            '.toggle-btn:hover {',
            '  background: #334155 !important;',
            '  border-color: #3b82f6 !important;',
            '  color: #ffffff !important;',
            '}',
            '/* Tabs */',
            '.replacer-tabs {',
            '  background: #1e293b !important;',
            '  border-bottom: 1px solid #334151 !important;',
            '  display: flex !important;',
            '  padding: 0 16px !important;',
            '  gap: 16px !important;',
            '}',
            '.replacer-tab-btn {',
            '  background: none !important;',
            '  border: none !important;',
            '  padding: 12px 0 !important;',
            '  font-size: 13px !important;',
            '  font-weight: 600 !important;',
            '  color: #94a3b8 !important;',
            '  cursor: pointer !important;',
            '  position: relative !important;',
            '  transition: color 0.2s ease !important;',
            '}',
            '.replacer-tab-btn.active {',
            '  color: #3b82f6 !important;',
            '}',
            '.replacer-tab-btn.active::after {',
            '  content: "" !important;',
            '  position: absolute !important;',
            '  bottom: 0 !important;',
            '  left: 0 !important;',
            '  right: 0 !important;',
            '  height: 2.5px !important;',
            '  background: #3b82f6 !important;',
            '  border-radius: 9999px !important;',
            '}',
            '/* Body & Scrollbars */',
            '.replacer-body {',
            '  flex: 1 !important;',
            '  overflow-y: auto !important;',
            '  background: #0f172a !important;',
            '  display: flex !important;',
            '  flex-direction: column !important;',
            '  padding-bottom: 20px !important;',
            '}',
            '.tab-pane {',
            '  display: none !important;',
            '  padding: 16px !important;',
            '  flex-direction: column !important;',
            '  flex: 1 !important;',
            '  overflow-y: auto !important; /* Scrollbar diaktifkan penuh pada tab editor & terms */',
            '  max-height: calc(60vh - 150px) !important;',
            '}',
            '.tab-pane.active {',
            '  display: flex !important;',
            '}',
            '/* Common Card Box */',
            '.card-box {',
            '  background: #1e293b !important;',
            '  border: 1px solid #334155 !important;',
            '  border-radius: 10px !important;',
            '  padding: 10px 12px !important;',
            '  margin-bottom: 8px !important;',
            '}',
            '/* Forms & Inputs */',
            '.editor-label {',
            '  font-size: 12px !important;',
            '  font-weight: 600 !important;',
            '  color: #94a3b8 !important;',
            '}',
            '.form-input {',
            '  width: 100% !important;',
            '  box-sizing: border-box !important;',
            '  padding: 8px 12px !important;',
            '  font-size: 13px !important;',
            '  border: 1px solid #475569 !important;',
            '  border-radius: 8px !important;',
            '  background: #0f172a !important;',
            '  color: #ffffff !important;',
            '  transition: border-color 0.2s ease !important;',
            '}',
            'select.form-input {',
            '  appearance: none !important;',
            '  -webkit-appearance: none !important;',
            '  -moz-appearance: none !important;',
            '  background-image: url("data:image/svg+xml;utf8,<svg fill=\'%2394a3b8\' height=\'24\' viewBox=\'0 0 24 24\' width=\'24\' xmlns=\'http://www.w3.org/2000/svg\'><path d=\'M7 10l5 5 5-5z\'/><path d=\'M0 0h24v24H0z\' fill=\'none\'/></svg>") !important;',
            '  background-repeat: no-repeat !important;',
            '  background-position: right 10px center !important;',
            '  background-size: 18px !important;',
            '  padding-right: 32px !important;',
            '  cursor: pointer !important;',
            '}',
            'select.form-input::-ms-expand {',
            '  display: none !important;',
            '}',
            '.form-input:focus {',
            '  outline: none !important;',
            '  border-color: #3b82f6 !important;',
            '}',
            '/* Buttons */',
            '.form-btn {',
            '  background: #1e293b !important;',
            '  border: 1px solid #475569 !important;',
            '  color: #e2e8f0 !important;',
            '  border-radius: 20px !important;',
            '  padding: 8px 16px !important;',
            '  font-size: 12px !important;',
            '  font-weight: 600 !important;',
            '  cursor: pointer !important;',
            '  transition: all 0.2s ease !important;',
            '}',
            '.form-btn:hover {',
            '  background: #334155 !important;',
            '  border-color: #3b82f6 !important;',
            '  color: #ffffff !important;',
            '}',
            '.btn-pill-primary {',
            '  background: #2563eb !important;',
            '  border: 1px solid #3b82f6 !important;',
            '  color: #ffffff !important;',
            '  border-radius: 20px !important;',
            '  padding: 8px 16px !important;',
            '  font-size: 12px !important;',
            '  font-weight: 700 !important;',
            '  cursor: pointer !important;',
            '  transition: all 0.2s ease !important;',
            '}',
            '.btn-pill-primary:hover {',
            '  background: #3b82f6 !important;',
            '}',
            '/* Word Item Layout */',
            '.word-item {',
            '  display: flex !important;',
            '  justify-content: space-between !important;',
            '  align-items: center !important;',
            '  padding: 10px 12px !important;',
            '  border-bottom: 1px solid #334155 !important;',
            '}',
            '.word-item:last-child {',
            '  border-bottom: none !important;',
            '}',
            '.word-pair {',
            '  display: flex !important;',
            '  flex-direction: column !important;',
            '  min-width: 0 !important;',
            '  flex: 1 !important;',
            '  gap: 2px !important;',
            '}',
            '.word-pair span {',
            '  font-size: 12px !important;',
            '}',
            '/* Utilities */',
            '.flex-col { display: flex !important; flex-direction: column !important; }',
            '.flex-row { display: flex !important; align-items: center !important; }',
            '.flex-between { display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 8px !important; }',
            '.input-wrapper-box { position: relative !important; display: flex !important; align-items: center !important; background: #0f172a !important; border: 1px solid #475569 !important; border-radius: 8px !important; box-sizing: border-box !important; }',
            '.input-wrapper-box:focus-within { border-color: #3b82f6 !important; }',
            '.txt-ellipsis { white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }',
            '.mono-font { font-family: monospace !important; }',
            '/* Language Dropdown Styles */',
            '.lang-dropdown-container { position: relative !important; display: inline-block !important; }',
            '.active-lang-btn { background: #1e293b !important; border: 1px solid #475569 !important; color: #f8fafc !important; padding: 4px 8px !important; border-radius: 8px !important; font-size: 11px !important; cursor: pointer !important; display: flex !important; align-items: center !important; gap: 4px !important; transition: all 0.2s ease !important; }',
            '.active-lang-btn:hover { background: #334155 !important; border-color: #3b82f6 !important; }',
            '.lang-dropdown-menu { display: none !important; position: absolute !important; right: 0 !important; top: 100% !important; margin-top: 4px !important; background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5) !important; z-index: 100000001 !important; min-width: 120px !important; overflow: hidden !important; }',
            '.lang-dropdown-menu.show { display: block !important; }',
            '.lang-dropdown-item { width: 100% !important; background: none !important; border: none !important; color: #cbd5e1 !important; padding: 8px 12px !important; font-size: 11px !important; text-align: left !important; cursor: pointer !important; display: flex !important; align-items: center !important; gap: 8px !important; transition: all 0.15s ease !important; display: block !important; }',
            '.lang-dropdown-item:hover { background: #334155 !important; color: #ffffff !important; }',
            '.lang-dropdown-item.active { background: #2563eb !important; color: #ffffff !important; }',
            '/* Gear/⚙️ Dropdown di Sisi Kiri (Aman Dari Clipping) */',
            '.group-menu-container { position: relative !important; display: inline-flex !important; align-items: center !important; z-index: 100 !important; }',
            '.group-menu-btn { background: none !important; border: none !important; color: #94a3b8 !important; font-size: 14px !important; cursor: pointer !important; padding: 4px 6px !important; display: flex !important; align-items: center !important; justify-content: center !important; transition: color 0.15s ease !important; }',
            '.group-menu-btn:hover { color: #ffffff !important; }',
            '.group-dropdown-menu { display: none !important; position: absolute !important; left: 0 !important; top: 100% !important; margin-top: 4px !important; background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; box-shadow: 0 10px 20px rgba(0, 0, 0, 0.5) !important; z-index: 100000002 !important; min-width: 170px !important; overflow: hidden !important; }',
            '.group-dropdown-menu.show { display: block !important; }',
            '.group-dropdown-item { width: 100% !important; background: none !important; border: none !important; color: #cbd5e1 !important; padding: 8px 12px !important; font-size: 11px !important; text-align: left !important; cursor: pointer !important; transition: all 0.15s ease !important; display: block !important; }',
            '.group-dropdown-item:hover { background: #334155 !important; color: #ffffff !important; }',
            '.group-dropdown-item.danger { color: #f87171 !important; }',
            '.group-dropdown-item.danger:hover { background: #991b1b !important; color: #ffffff !important; }',
            '/* Tooltips Styles */',
            '.replacer-tooltip-container { position: fixed !important; background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 8px !important; padding: 8px 12px !important; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5) !important; z-index: 100000005 !important; pointer-events: auto !important; display: none !important; flex-direction: column !important; gap: 4px !important; min-width: 150px !important; }',
            '.replacer-tooltip-container.visible { display: flex !important; }',
            '.tooltip-row-from { font-size: 10px !important; color: #94a3b8 !important; }',
            '.tooltip-val-original { font-weight: bold !important; color: #ef4444 !important; }',
            '.tooltip-row-to { font-size: 11px !important; color: #f1f5f9 !important; display: flex !important; align-items: center !important; gap: 4px !important; }',
            '.tooltip-badge { background: rgba(59, 130, 246, 0.15) !important; color: #60a5fa !important; padding: 2px 6px !important; border-radius: 4px !important; font-size: 10px !important; font-weight: bold !important; }',
            '.tooltip-footer { margin-top: 4px !important; border-top: 1px solid #334155 !important; padding-top: 4px !important; display: flex !important; justify-content: flex-end !important; }',
            '.tooltip-edit-btn { background: #1e293b !important; border: 1px solid #475569 !important; color: #60a5fa !important; font-size: 9px !important; font-weight: bold !important; padding: 2px 6px !important; border-radius: 4px !important; cursor: pointer !important; transition: all 0.15s ease !important; }',
            '.tooltip-edit-btn:hover { background: #334155 !important; border-color: #3b82f6 !important; }',
            '/* Toggle Switches */',
            '.switch { position: relative !important; display: inline-block !important; width: 36px !important; height: 20px !important; flex-shrink: 0 !important; }',
            '.switch input { opacity: 0 !important; width: 0 !important; height: 0 !important; }',
            '.slider { position: absolute !important; cursor: pointer !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; background-color: #334155 !important; transition: .3s !important; border-radius: 20px !important; }',
            '.slider::before { position: absolute !important; content: "" !important; height: 14px !important; width: 14px !important; left: 3px !important; bottom: 3px !important; background-color: white !important; transition: .3s !important; border-radius: 50% !important; }',
            'input:checked + .slider { background-color: #2563eb !important; }',
            'input:checked + .slider::before { transform: translateX(16px) !important; }',
            '/* Settings Content Styles */',
            '.setting-row { display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 8px 0 !important; gap: 12px !important; }',
            '.setting-info { display: flex !important; flex-direction: column !important; flex: 1 !important; }',
            '.setting-title { font-size: 12px !important; font-weight: 600 !important; color: #ffffff !important; }',
            '.setting-desc { font-size: 10px !important; color: #94a3b8 !important; }',
            '/* Suggestion Chips */',
            '.suggestion-chips { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; margin-top: 8px !important; }',
            '.suggestion-chip { background: #1e293b !important; border: 1px solid #334155 !important; color: #cbd5e1 !important; border-radius: 6px !important; padding: 4px 8px !important; font-size: 10px !important; cursor: pointer !important; transition: all 0.15s ease !important; }',
            '.suggestion-chip:hover { background: #334155 !important; border-color: #3b82f6 !important; color: #ffffff !important; }',
            '/* Domain Lists & Empty States */',
            '.domain-item { display: flex !important; justify-content: space-between !important; align-items: center !important; background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; padding: 6px 10px !important; margin-bottom: 4px !important; font-size: 11px !important; }',
            '.domain-list { max-height: 150px !important; overflow-y: auto !important; margin-bottom: 8px !important; }',
            '.empty-state { text-align: center !important; padding: 20px 10px !important; color: #94a3b8 !important; font-size: 11px !important; font-style: italic !important; }',
            '/* Toast Alert Styles */',
            '.replacer-toast { position: fixed !important; bottom: 20px !important; right: 20px !important; background: #1e293b !important; border: 1px solid #334155 !important; border-left: 4px solid #3b82f6 !important; color: #ffffff !important; padding: 10px 16px !important; border-radius: 8px !important; font-size: 12px !important; font-weight: 600 !important; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5) !important; z-index: 100000010 !important; display: none !important; align-items: center !important; gap: 8px !important; max-width: 300px !important; }',
            '.replacer-toast.show { display: flex !important; }',
            '.replacer-toast.success { border-left-color: #10b981 !important; }',
            '.replacer-toast.warn { border-left-color: #f59e0b !important; }',
            '.replacer-toast.info { border-left-color: #3b82f6 !important; }',
            '/* Konfirmasi Pop Cantik (Confirm Modal) */',
            '.replacer-confirm-overlay { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; background: rgba(15, 23, 42, 0.8) !important; backdrop-filter: blur(4px) !important; z-index: 100000050 !important; display: flex !important; align-items: center !important; justify-content: center !important; }',
            '.replacer-confirm-box { background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 12px !important; padding: 16px !important; width: 85% !important; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.6) !important; display: flex !important; flex-direction: column !important; gap: 12px !important; animation: modalSlideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important; }',
            '.replacer-confirm-header { font-size: 13px !important; font-weight: 800 !important; color: #f8fafc !important; border-bottom: 1px solid #334155 !important; padding-bottom: 8px !important; text-transform: uppercase !important; letter-spacing: 0.05em !important; }',
            '.replacer-confirm-body { font-size: 11px !important; color: #cbd5e1 !important; line-height: 1.5 !important; }',
            '.replacer-confirm-footer { display: flex !important; justify-content: flex-end !important; gap: 8px !important; margin-top: 4px !important; }',
            '@keyframes modalSlideIn { from { transform: scale(0.95) translateY(10px) !important; opacity: 0 !important; } to { transform: scale(1) translateY(0) !important; opacity: 1 !important; } }',
            '/* Animations */',
            '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'
        ].join('\n');
        shadow.appendChild(style);

        const wrapper = document.createElement('div');
        wrapper.className = 'replacer-wrapper';
        shadow.appendChild(wrapper);

        const tooltipEl = document.createElement('div');
        tooltipEl.className = 'replacer-tooltip-container';
        wrapper.appendChild(tooltipEl);

        toast = document.createElement('div');
        toast.className = 'replacer-toast';
        wrapper.appendChild(toast);

        function hilangkanFokusShadow() {
            if (shadow && shadow.activeElement) {
                shadow.activeElement.blur();
            }
        }

        const launcher = document.createElement('button');
        launcher.className = 'replacer-launcher';
        launcher.innerHTML = `
            <span style="display: flex; align-items: center; justify-content: center;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 15px; height: 15px;">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
            </span>
            <span style="line-height: 1;">AWR Tools</span>
        `;
        wrapper.appendChild(launcher);

        const panel = document.createElement('div');
        panel.className = 'replacer-panel hidden';
        wrapper.appendChild(panel);

        function tampilkanKonfirmasi(judul, deskripsi, onConfirm, onCancel = null) {
            const existing = panel.querySelector('.replacer-confirm-overlay');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.className = 'replacer-confirm-overlay';
            overlay.innerHTML = `
                <div class="replacer-confirm-box">
                    <div class="replacer-confirm-header">${judul}</div>
                    <div class="replacer-confirm-body">${deskripsi}</div>
                    <div class="replacer-confirm-footer">
                        <button class="form-btn confirm-cancel-btn">Batal</button>
                        <button class="form-btn btn-pill-primary confirm-ok-btn" style="background: #ef4444 !important; border-color: #ef4444 !important;">Lanjutkan</button>
                    </div>
                </div>
            `;

            overlay.querySelector('.confirm-cancel-btn').onclick = (e) => {
                e.stopPropagation();
                overlay.remove();
                if (onCancel) onCancel();
            };

            overlay.querySelector('.confirm-ok-btn').onclick = (e) => {
                e.stopPropagation();
                overlay.remove();
                onConfirm();
            };

            panel.appendChild(overlay);
        }

        function renderCloudGistManager(container, gistDetails) {
            const token = getGitHubToken();
            const gistId = getGistId();
            const ownerName = gistDetails?.owner?.login || "GitHub User";

            container.innerHTML = `
                <div class="flex-col card-box" style="gap: 8px !important; margin-bottom: 12px !important;">
                    <div class="flex-between" style="font-size: 11px !important;">
                        <span style="color: #9ca3af !important; font-weight: 500 !important;">Connected as:</span>
                        <span style="color: #38bdf8 !important; font-weight: bold !important;">🐱 @${ownerName}</span>
                    </div>
                    <div class="flex-between" style="font-size: 11px !important; border-top: 1px dashed #334155 !important; padding-top: 8px !important;">
                        <span style="color: #9ca3af !important; flex-shrink: 0 !important;">Gist ID:</span>
                        <span class="mono-font txt-ellipsis" style="color: #60a5fa !important; flex: 1 !important; text-align: right !important; margin-right: 6px !important;" title="${gistId}">
                            ${gistId}
                        </span>
                        <button class="action-btn copy-gist-id-btn" style="padding: 2px !important; background: none; border: none; cursor: pointer;" title="Copy Gist ID">📋</button>
                    </div>
                    <div class="flex-between" style="font-size: 11px !important;">
                        <span style="color: #9ca3af !important; flex-shrink: 0 !important;">GitHub Token:</span>
                        <input type="password" readonly class="txt-copyable-token mono-font" value="${token}" style="background: transparent !important; border: none !important; color: #cbd5e1 !important; font-size: 11px !important; flex: 1 !important; text-align: right !important; outline: none !important; width: 100px !important; margin-right: 6px !important;" />
                        <button class="action-btn toggle-token-view-btn" style="background: none !important; border: none !important; cursor: pointer !important; padding: 2px !important; color: #94a3b8 !important;" title="Show/Hide Token">👁️</button>
                        <button class="action-btn copy-token-btn" style="background: none !important; border: none !important; cursor: pointer !important; padding: 2px !important;" title="Copy Token">📋</button>
                    </div>
                    <div class="flex-between" style="margin-top: 6px !important; border-top: 1px dashed #334155 !important; padding-top: 8px !important;">
                        <button class="form-btn manual-upload-btn btn-pill-primary" style="padding: 5px 14px !important;">
                            Backup Now
                        </button>
                        <button class="form-btn btn-switch-github btn-pill" style="padding: 5px 14px !important; color: #ef4444 !important; border-color: #ef4444 !important;">
                            Logout
                        </button>
                    </div>
                </div>

                <div style="font-size: 11px !important; font-weight: bold !important; margin-bottom: 8px !important; color: #94a3b8 !important; border-bottom: 1px solid #334155 !important; padding-bottom: 4px !important; text-transform: uppercase !important; letter-spacing: 0.05em !important;">
                    🕒 Revision History
                </div>

                <div class="cloud-baskets-list flex-col" style="gap: 6px !important; max-height: 180px !important; overflow-y: auto !important; padding-right: 4px !important;">
                </div>
            `;

            container.querySelector('.copy-gist-id-btn').onclick = () => {
                navigator.clipboard.writeText(gistId);
                panggilToast("Gist ID disalin ke clipboard!", "success");
            };

            container.querySelector('.copy-token-btn').onclick = () => {
                navigator.clipboard.writeText(token);
                panggilToast("GitHub Token disalin ke clipboard!", "success");
            };

            const tInput = container.querySelector('.txt-copyable-token');
            const viewBtn = container.querySelector('.toggle-token-view-btn');
            viewBtn.onclick = () => {
                if (tInput.type === 'password') {
                    tInput.type = 'text';
                    viewBtn.textContent = '🙈';
                } else {
                    tInput.type = 'password';
                    viewBtn.textContent = '👁️';
                }
            };

            container.querySelector('.manual-upload-btn').onclick = async () => {
                const listContainer = container.querySelector('.cloud-baskets-list');
                const originalHTML = listContainer.innerHTML;
                listContainer.innerHTML = `
                    <div class="cloud-loading-spinner flex-col" style="align-items: center !important; justify-content: center !important; padding: 30px !important; gap: 10px !important;">
                        <span style="font-size: 24px !important; animation: spin 1s linear infinite !important; display: inline-block !important;">⏳</span>
                        <span style="font-size: 11px !important; color: #94a3b8 !important;">Creating backup...</span>
                    </div>
                `;
                panggilToast("Mencadangkan kata ke GitHub...", "info");
                await simpanKeAwan(null, null, null, true);
                
                const freshDetails = await fetchGistDetails(token, gistId);
                if (freshDetails) {
                    panggilToast("Kamus kata berhasil dicadangkan!", "success");
                    renderCloudGistManager(container, freshDetails);
                } else {
                    listContainer.innerHTML = originalHTML;
                    panggilToast("Gagal mengambil riwayat terbaru.", "warn");
                }
            };

            container.querySelector('.btn-switch-github').onclick = () => {
                tampilkanKonfirmasi(
                    "Logout Akun?",
                    "Apakah Anda yakin ingin memutuskan koneksi akun GitHub saat ini? Seluruh data kamus lokal Anda tidak akan terhapus.",
                    () => {
                        saveGitHubCredentials("", "");
                        panggilToast(t('toast_account_switched'), 'info');
                        renderTampilan();
                    }
                );
            };

            const listContainer = container.querySelector('.cloud-baskets-list');

            if (!gistDetails || !gistDetails.files) {
                listContainer.innerHTML = `<div class="empty-state">${t('no_backups_found')}</div>`;
                return;
            }

            const backupFiles = Object.keys(gistDetails.files)
                .filter(name => name.startsWith('backup_') && name.endsWith('.json'))
                .sort()
                .reverse();

            if (backupFiles.length === 0) {
                listContainer.innerHTML = `<div class="empty-state">${t('no_backups_found')}</div>`;
                return;
            }

            backupFiles.forEach((filename) => {
                const friendlyName = parseBackupFilename(filename);
                const fileData = gistDetails.files[filename];

                const item = document.createElement('div');
                item.className = 'flex-between bg-box p-box';
                item.setAttribute('style', 'background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; padding: 8px 12px !important; margin-bottom: 4px !important;');

                item.innerHTML = `
                    <div class="flex-col" style="min-width: 0 !important; flex: 1 !important; gap: 2px !important;">
                        <span class="mono-font txt-ellipsis" style="font-size: 11px !important; font-weight: bold !important; color: #f1f5f9 !important;" title="${filename}">
                            ${friendlyName}
                        </span>
                    </div>
                    <div class="flex-row" style="gap: 4px !important; flex-shrink: 0 !important;">
                        <button class="form-btn restore-revision-btn btn-pill-primary" style="padding: 4px 10px !important; font-size: 10px !important; border-radius: 12px !important;">
                            ${t('btn_load')}
                        </button>
                        <button class="form-btn delete-revision-btn btn-pill" style="background: none !important; border: 1px solid #ef4444 !important; color: #f87171 !important; padding: 4px 8px !important; font-size: 10px !important; border-radius: 12px !important;" title="Hapus cadangan ini">
                            🗑️
                        </button>
                    </div>
                `;

                item.querySelector('.restore-revision-btn').onclick = () => {
                    tampilkanKonfirmasi(
                        "Muat Cadangan Kata?",
                        `Apakah Anda yakin ingin memulihkan cadangan kata pada tanggal ${friendlyName}? Seluruh kata lokal Anda saat ini akan sepenuhnya ditimpa.`,
                        async () => {
                            panggilToast(t('toast_sync_connecting'), 'info');
                            try {
                                let contentText = fileData.content;
                                if (!contentText && fileData.raw_url) {
                                    const rawRes = await gmFetch(fileData.raw_url);
                                    if (rawRes.ok) {
                                        contentText = await rawRes.text();
                                    }
                                }
                                if (contentText) {
                                    const parsedData = JSON.parse(contentText);
                                    if (parsedData) {
                                        if (parsedData.kamus) GM_setValue("kamus_kata_v5", JSON.stringify(parsedData.kamus));
                                        if (parsedData.domains) GM_setValue("target_domains_v4", JSON.stringify(parsedData.domains));
                                        if (parsedData.blacklist) GM_setValue("blacklist_domains_v1", JSON.stringify(parsedData.blacklist));
                                        if (parsedData.filterMode) GM_setValue("filter_mode_v1", parsedData.filterMode);
                                        if (parsedData.deletedWords) GM_setValue("awr_deleted_words_v1", JSON.stringify(parsedData.deletedWords));
                                        if (parsedData.novelTitles) GM_setValue("awr_novel_titles_v2", JSON.stringify(parsedData.novelTitles));
                                    }
                                    panggilToast(t('toast_revision_restored', friendlyName), 'success');
                                    jalankanPengganti(true);
                                    renderTampilan();
                                } else {
                                    alert("Gagal memuat isi berkas cadangan!");
                                }
                            } catch (err) {
                                console.error(err);
                                alert("Koneksi gagal saat memulihkan cadangan.");
                            }
                        }
                    );
                };

                const delRevBtn = item.querySelector('.delete-revision-btn');
                delRevBtn.onclick = (e) => {
                    e.stopPropagation();
                    tampilkanKonfirmasi(
                        "Hapus Berkas Cadangan?",
                        `Apakah Anda yakin ingin menghapus cadangan tanggal "${friendlyName}" dari GitHub secara permanen?`,
                        async () => {
                            panggilToast("Menghapus berkas cadangan dari GitHub...", "info");
                            try {
                                const response = await gmFetch(`https://api.github.com/gists/${gistId}`, {
                                    method: "PATCH",
                                    headers: {
                                        "Authorization": `token ${token}`,
                                        "Accept": "application/vnd.github.v3+json",
                                        "X-GitHub-Api-Version": "2022-11-28"
                                    },
                                    body: JSON.stringify({
                                        files: {
                                            [filename]: null
                                        }
                                    })
                                });
                                if (response.ok || response.status === 200) {
                                    panggilToast("Berkas cadangan berhasil dihapus!", "success");
                                    const freshDetails = await fetchGistDetails(token, gistId);
                                    renderCloudGistManager(container, freshDetails);
                                } else {
                                    alert("Gagal menghapus berkas cadangan dari GitHub Gist. Status: " + response.status);
                                }
                            } catch (err) {
                                console.error(err);
                                alert("Koneksi gagal saat mencoba menghapus berkas cadangan.");
                            }
                        }
                    );
                };

                listContainer.appendChild(item);
            });
        }

        function renderTampilan() {
            const domainAktif = isDomainAllowed();
            const seluruhKamus = getKamus();
            const activeLang = getLang();
            const activeFlag = TRANSLATIONS[activeLang]?.flag || "🇺🇸";
            const activeNovelId = getActiveNovelId();

            const lastSelectedGroup = GM_getValue("awr_last_selected_group_id_v2", "GLOBAL_OPTION");
            const lastCheckboxState = GM_getValue("awr_last_active_group_checkbox_state_v2", true);

            const langNames = {
                en: "English",
                id: "Indonesia"
            };

            panel.innerHTML = '';

            const header = document.createElement('div');
            header.className = 'replacer-header';
            header.innerHTML = `
                <div class="replacer-header-row" style="display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 8px !important;">
                    <span class="replacer-title">🐸 ${t('title')}</span>
                    <div class="lang-dropdown-container">
                        <button class="active-lang-btn">${activeFlag} <span style="font-size: 8px !important; line-height: 1 !important;">▼</span></button>
                        <div class="lang-dropdown-menu"></div>
                    </div>
                    <button class="replacer-close">✕</button>
                </div>
                <div class="replacer-host-status">
                    <div class="host-info">
                        <span class="host-label">${t('current_site')}</span>
                        <span class="host-name">${getNovelBaseDomain(currentHost)}</span>
                    </div>
                    <div class="status-actions">
                        <span class="status-badge ${domainAktif ? 'active' : 'inactive'}">
                            <span class="status-indicator ${domainAktif ? 'active' : 'inactive'}"></span>
                            ${domainAktif ? t('active') : t('off')}
                        </span>
                        <button class="toggle-btn ${domainAktif ? 'btn-active' : 'btn-inactive'}">
                            ${domainAktif ? t('disable') : t('enable')}
                        </button>
                    </div>
                </div>
            `;

            const dropdownMenu = header.querySelector('.lang-dropdown-menu');
            const activeBtn = header.querySelector('.active-lang-btn');

            activeBtn.onclick = (e) => {
                e.stopPropagation();
                dropdownMenu.classList.toggle('show');
            };

            Object.keys(TRANSLATIONS).forEach(langKey => {
                const itemBtn = document.createElement('button');
                itemBtn.className = 'lang-dropdown-item';
                if (langKey === activeLang) {
                    itemBtn.classList.add('active');
                }
                itemBtn.innerHTML = `<span>${TRANSLATIONS[langKey].flag}</span> <span style="font-family: inherit !important;">${langNames[langKey]}</span>`;

                itemBtn.onclick = (e) => {
                    e.stopPropagation();
                    saveLang(langKey);
                    dropdownMenu.classList.remove('show');
                    renderTampilan();
                };
                dropdownMenu.appendChild(itemBtn);
            });

            header.querySelector('.replacer-close').onclick = () => {
                panel.classList.add('hidden');
                hilangkanFokusShadow();
            };

            header.querySelector('.toggle-btn').onclick = () => {
                const normalizedCurrent = getNovelBaseDomain(currentHost);
                const filterMode = getFilterMode();

                if (filterMode === "whitelist") {
                    let targets = getTargetDomains();
                    if (domainAktif) {
                        targets = targets.filter(d => {
                            const clean = getNovelBaseDomain(d.trim().toLowerCase());
                            return clean !== normalizedCurrent && !normalizedCurrent.endsWith('.' + clean);
                        });
                        saveTargetDomains(targets);
                        panggilToast(t('toast_removed_whitelist', normalizedCurrent), 'warn');
                    } else {
                        targets.push(normalizedCurrent);
                        saveTargetDomains(targets);
                        panggilToast(t('toast_added_whitelist', normalizedCurrent), 'success');
                    }
                    simpanKeAwan(null, targets);
                } else {
                    let blacklist = getBlacklistDomains();
                    if (domainAktif) {
                        blacklist.push(normalizedCurrent);
                        saveBlacklistDomains(blacklist);
                        panggilToast(t('toast_added_blacklist', normalizedCurrent), 'warn');
                    } else {
                        blacklist = blacklist.filter(d => {
                            const clean = getNovelBaseDomain(d.trim().toLowerCase());
                            return clean !== normalizedCurrent && !normalizedCurrent.endsWith('.' + clean);
                        });
                        saveBlacklistDomains(blacklist);
                        panggilToast(t('toast_removed_blacklist', normalizedCurrent), 'success');
                    }
                    simpanKeAwan();
                }
                jalankanPengganti(true);
                renderTampilan();
            };

            panel.appendChild(header);

            const tabsRow = document.createElement('div');
            tabsRow.className = 'replacer-tabs';
            tabsRow.innerHTML = `
                <button class="replacer-tab-btn ${tabAktif === 'tambah' ? 'active' : ''}" data-tab="tambah">${t('tab_editor')}</button>
                <button class="replacer-tab-btn ${tabAktif === 'daftar' ? 'active' : ''}" data-tab="daftar">${t('tab_terms')}</button>
                <button class="replacer-tab-btn ${tabAktif === 'recycle' ? 'active' : ''}" data-tab="recycle">${t('tab_recycle')}</button>
                <button class="replacer-tab-btn ${tabAktif === 'setting' ? 'active' : ''}" data-tab="setting">${t('tab_setting')}</button>
            `;

            tabsRow.querySelectorAll('.replacer-tab-btn').forEach(btn => {
                btn.onclick = () => {
                    const targetTab = btn.getAttribute('data-tab');
                    if (targetTab === 'tambah') {
                        subjekEdit = null;
                    }
                    tabAktif = targetTab;
                    renderTampilan();
                };
            });
            panel.appendChild(tabsRow);

            const body = document.createElement('div');
            body.className = 'replacer-body';
            panel.appendChild(body);

            if (tabAktif === 'daftar') {
                const pane = document.createElement('div');
                pane.className = 'tab-pane active';

                pane.innerHTML = `
                    <div class="search-action-bar" style="display: flex !important; gap: 6px !important; align-items: center !important; margin-bottom: 8px !important;">
                        <input type="text" class="form-input search-input" placeholder="${t('search_placeholder')}" style="flex: 1 !important;" />
                        <button class="form-btn bulk-delete-btn" style="display: none !important; width: auto !important; background: #ef4444 !important; color: white !important; padding: 7px 14px !important; font-size: 11px !important; border-radius: 20px !important; border: none !important; cursor: pointer !important; font-weight: bold !important;">${t('bulk_delete', '0')}</button>
                    </div>
                    <div class="select-all-row" style="display: flex !important; align-items: center !important; gap: 8px !important; padding: 6px 10px !important;">
                        <input type="checkbox" class="select-all-checkbox" style="cursor: pointer !important; margin: 0 !important;" />
                        <span>${t('select_all')} (<span class="total-count">0</span>)</span>
                    </div>
                    <!-- ── SOLUSI: Tombol Show/Hide dipindah ke atas daftar kata ── -->
                    <div class="toggle-other-placeholder"></div>
                    <div class="word-list"></div>
                    <div style="display: flex !important; justify-content: flex-end !important; margin-top: 10px !important;">
                        <button class="form-btn close-btn-terms btn-pill" style="background: #374151 !important; color: #d1d5db !important; padding: 6px 16px !important; font-size: 12px !important;">${t('close_btn')}</button>
                    </div>
                `;

                const listContainer = pane.querySelector('.word-list');
                const searchInput = pane.querySelector('.search-input');
                const selectAllCheckbox = pane.querySelector('.select-all-checkbox');
                const bulkDeleteBtn = pane.querySelector('.bulk-delete-btn');
                const totalCountSpan = pane.querySelector('.total-count');

                let terpilih = [];

                pane.querySelector('.close-btn-terms').onclick = () => {
                    panel.classList.add('hidden');
                    hilangkanFokusShadow();
                };

                function perbaruiStatusMassal(filteredKeys) {
                    if (filteredKeys.length > 0 && terpilih.length === filteredKeys.length) {
                        selectAllCheckbox.checked = true;
                    } else {
                        selectAllCheckbox.checked = false;
                    }
                    totalCountSpan.textContent = terpilih.length;
                    if (terpilih.length > 0) {
                        bulkDeleteBtn.style.display = 'block';
                        bulkDeleteBtn.textContent = t('bulk_delete', terpilih.length);
                    } else {
                        bulkDeleteBtn.style.display = 'none';
                    }
                }

                function saringDanTampilkan(kueri = '') {
                    listContainer.innerHTML = '';

                    const keysFiltered = Object.keys(seluruhKamus).filter(k => {
                        const item = seluruhKamus[k];
                        const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');
                        return k.toLowerCase().includes(kueri) || toVal.toLowerCase().includes(kueri);
                    });

                    const globalKeys = [];
                    const currentLocalKeys = [];
                    const otherLocalKeys = [];

                    const currentNovel = getNovelContext();

                    keysFiltered.forEach(k => {
                        const item = seluruhKamus[k];
                        if (item && typeof item === 'object') {
                            if (item.global) {
                                globalKeys.push(k);
                            } else if (item.novelId) {
                                if (item.novelId === currentNovel.id) {
                                    currentLocalKeys.push(k);
                                } else {
                                    otherLocalKeys.push(k);
                                }
                            } else {
                                const pageBaseDomain = getNovelBaseDomain(currentHost);
                                const termBaseDomain = getNovelBaseDomain(item.domain);
                                const isLocal = termBaseDomain === pageBaseDomain || (termBaseDomain && pageBaseDomain.endsWith('.' + termBaseDomain));
                                if (isLocal) {
                                    currentLocalKeys.push(k);
                                } else {
                                    otherLocalKeys.push(k);
                                }
                            }
                        } else if (typeof item === 'string') {
                            globalKeys.push(k);
                        }
                    });

                    globalKeys.sort();
                    currentLocalKeys.sort();

                    const totalAktif = globalKeys.length + currentLocalKeys.length;

                    if (totalAktif === 0 && (!showOtherTerms || otherLocalKeys.length === 0)) {
                        listContainer.innerHTML = `<div class="empty-state">${t('empty_state')}</div>`;
                        perbaruiStatusMassal(keysFiltered);
                        renderToggleOtherBtn(otherLocalKeys);
                        return;
                    }

                    if (globalKeys.length > 0) {
                        const gHeader = document.createElement('div');
                        gHeader.className = 'btn-pill-primary';
                        gHeader.setAttribute('style', 'margin: 10px 10px 6px 10px !important; width: fit-content !important;');
                        gHeader.textContent = 'Global';
                        listContainer.appendChild(gHeader);

                        globalKeys.forEach(k => {
                            renderItem(k, listContainer, false);
                        });
                    }

                    if (currentLocalKeys.length > 0) {
                        const localHeader = document.createElement('div');
                        localHeader.setAttribute('style', 'display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 10px 10px 6px 10px !important; margin-top: 10px !important;');

                        const localTitle = currentNovel.title || "Current Novel";
                        const isActiveLocal = activeNovelId ? (currentNovel.id === activeNovelId) : true;

                        localHeader.innerHTML = `
                            <div style="display: flex !important; align-items: center !important; gap: 6px !important; width: 100% !important; position: relative !important;">
                                <div class="group-menu-container">
                                    <button class="group-menu-btn" title="Grup Menu">⚙️</button>
                                    <div class="group-dropdown-menu">
                                        <button class="group-dropdown-item toggle-active-novel-btn" data-id="${currentNovel.id}">${isActiveLocal ? '❌ Nonaktifkan Grup' : '🟢 Aktifkan Grup'}</button>
                                        <button class="group-dropdown-item danger delete-novel-group-btn" data-id="${currentNovel.id}" data-title="${localTitle}">🗑 Hapus Grup</button>
                                    </div>
                                </div>
                                <span class="local-novel-title-btn btn-pill" data-id="${currentNovel.id}" title="Klik untuk mengubah nama novel" style="flex: 1 !important; text-align: left !important;">
                                    ${localTitle} ✏️ ${isActiveLocal ? '🟢' : ''}
                                </span>
                            </div>
                            ${currentNovel.url ? `
                            <a href="${currentNovel.url}" target="_blank" class="btn-pill" style="border-radius: 20px !important; text-decoration: none !important; margin-left: 6px !important;">📖</a>` : ''}
                        `;
                        listContainer.appendChild(localHeader);

                        currentLocalKeys.forEach(k => {
                            renderItem(k, listContainer, false);
                        });
                    }

                    renderToggleOtherBtn(otherLocalKeys);

                    if (showOtherTerms && otherLocalKeys.length > 0) {
                        const otherGroups = {};
                        otherLocalKeys.forEach(k => {
                            const item = seluruhKamus[k];
                            let gId = item?.novelId || `domain_${getNovelBaseDomain(item.domain) || 'unknown'}`;
                            let gTitle = getCachedNovelTitle(gId) || item?.novelTitle || getNovelBaseDomain(item.domain) || 'Unknown Novel';
                            if (!otherGroups[gId]) otherGroups[gId] = { title: gTitle, keys: [] };
                            otherGroups[gId].keys.push(k);
                        });

                        Object.keys(otherGroups).sort((a, b) => {
                            return otherGroups[a].title.localeCompare(otherGroups[b].title);
                        }).forEach(gId => {
                            const group = otherGroups[gId];
                            group.keys.sort();
                            const isActiveGroup = activeNovelId ? (gId === activeNovelId) : (gId === currentNovel.id);

                            const groupHeader = document.createElement('div');
                            groupHeader.setAttribute('style', 'display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 10px 10px 6px 10px !important; margin-top: 10px !important;');

                            groupHeader.innerHTML = `
                                <div style="display: flex !important; align-items: center !important; gap: 6px !important; width: 100% !important; position: relative !important;">
                                    <div class="group-menu-container">
                                        <button class="group-menu-btn" title="Grup Menu">⚙️</button>
                                        <div class="group-dropdown-menu">
                                            <button class="group-dropdown-item toggle-active-novel-btn" data-id="${gId}">${isActiveGroup ? '❌ Nonaktifkan Grup' : '🟢 Aktifkan Grup'}</button>
                                            <button class="group-dropdown-item danger delete-novel-group-btn" data-id="${gId}" data-title="${group.title}">🗑 Hapus Grup</button>
                                        </div>
                                    </div>
                                    <span class="local-novel-title-btn btn-pill" data-id="${gId}" title="Klik untuk mengubah nama novel" style="flex: 1 !important; text-align: left !important;">
                                        ${group.title} (${group.keys.length}) ${isActiveGroup ? '🟢' : ''}
                                    </span>
                                </div>
                            `;
                            listContainer.appendChild(groupHeader);

                            group.keys.forEach(k => {
                                renderItem(k, listContainer, true);
                            });
                        });
                    }

                    pane.querySelectorAll('.group-menu-btn').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const dropdown = btn.nextElementSibling;
                            pane.querySelectorAll('.group-dropdown-menu').forEach(menu => { 
                                if (menu !== dropdown) menu.classList.remove('show'); 
                            });
                            dropdown.classList.toggle('show');
                        };
                    });

                    pane.querySelectorAll('.local-novel-title-btn').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const nId = btn.getAttribute('data-id');
                            const currentTitle = getCachedNovelTitle(nId) || (seluruhKamus[Object.keys(seluruhKamus).find(k => seluruhKamus[k].novelId === nId)]?.novelTitle) || "Novel";
                            ubahJudulNovel(nId, currentTitle);
                        };
                    });

                    pane.querySelectorAll('.toggle-active-novel-btn').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const nId = btn.getAttribute('data-id');
                            const isActive = activeNovelId ? (nId === activeNovelId) : (nId === currentNovel.id);

                            if (isActive) {
                                setActiveNovelId("");
                                panggilToast("Grup novel dinonaktifkan (Kembali ke mode alami situs)", 'info');
                            } else {
                                setActiveNovelId(nId);
                                panggilToast(`Grup novel "${getCachedNovelTitle(nId) || nId}" berhasil diaktifkan secara eksklusif`, 'success');
                            }
                            jalankanPengganti(true);
                            renderTampilan();
                        };
                    });

                    pane.querySelectorAll('.delete-novel-group-btn').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const nId = btn.getAttribute('data-id');
                            const nTitle = btn.getAttribute('data-title');
                            tampilkanKonfirmasi(
                                "Hapus Seluruh Grup Kata?",
                                `Apakah Anda yakin ingin menghapus seluruh kata/aturan dalam grup novel "${nTitle}"? Aturan ini akan dipindahkan ke Recycle Bin.`,
                                () => {
                                    const tempKamus = getKamus();
                                    const deletedWords = getDeletedWords();
                                    let count = 0;

                                    for (const salah in tempKamus) {
                                        if (tempKamus[salah].novelId === nId) {
                                            deletedWords[salah] = tempKamus[salah];
                                            delete tempKamus[salah];
                                            count++;
                                        }
                                    }

                                    saveKamus(tempKamus);
                                    saveDeletedWords(deletedWords);

                                    try {
                                        const cacheVal = GM_getValue("awr_novel_titles_v2", "{}");
                                        const cache = typeof cacheVal === "string" ? JSON.parse(cacheVal) : cacheVal;
                                        delete cache[nId];
                                        GM_setValue("awr_novel_titles_v2", JSON.stringify(cache));
                                    } catch (err) {}

                                    if (getActiveNovelId() === nId) setActiveNovelId("");
                                    simpanKeAwan(tempKamus, null, deletedWords);
                                    panggilToast(`Berhasil memindahkan seluruh grup "${nTitle}" (${count} kata dihapus) ke Recycle Word`, 'warn');
                                    jalankanPengganti(true);
                                    renderTampilan();
                                }
                            );
                        };
                    });

                    perbaruiStatusMassal(keysFiltered);
                }

                function renderItem(k, container, isFromOther = false) {
                    const itemData = seluruhKamus[k];
                    const item = document.createElement('div');
                    item.className = 'word-item flex-row p-box';
                    item.setAttribute('style', 'border-bottom: 1px solid #334155 !important;' + (isFromOther ? 'opacity: 0.7;' : ''));

                    const checked = terpilih.includes(k) ? 'checked' : '';
                    const toVal = (itemData && typeof itemData === 'object' && typeof itemData.to === 'string') ? itemData.to : (typeof item === 'string' ? item : '');

                    let badgeHTML = '';
                    if (itemData && typeof itemData === 'object') {
                        if (itemData.global) {
                            badgeHTML = `<span class="term-badge global">🌐 ${t('global_replacer')}</span>`;
                        } else {
                            const cleanTermDomain = getCachedNovelTitle(itemData.novelId) || itemData.novelTitle || getNovelBaseDomain(itemData.domain) || "Novel";
                            badgeHTML = `<span class="term-badge local">📖 ${t('local_replacer')} (${cleanTermDomain})</span>`;
                        }
                    } else {
                        badgeHTML = `<span class="term-badge global">🌐 ${t('global_replacer')}</span>`;
                    }

                    item.innerHTML = `
                        <input type="checkbox" class="word-checkbox" data-key="${k.replace(/"/g, '&quot;')}" ${checked} style="cursor: pointer !important; margin: 0 4px 0 0 !important; flex-shrink: 0 !important;" />
                        <button class="action-btn edit-btn-spec btn-pill" style="border-radius: 20px !important; flex-shrink: 0 !important; margin-right: 8px !important;">Edit</button>
                        <div class="word-pair flex-col" style="gap: 2px !important; min-width: 0 !important; flex: 1 !important;">
                            <span class="ellipsis" style="font-size: 12px !important; font-weight: 500 !important; color: #e5e7eb !important;"><span style="color: #6b7280 !important; font-weight: bold !important;">FROM:</span> ${k}</span>
                            <span class="ellipsis" style="font-size: 12px !important; font-weight: 500 !important; color: #e5e7eb !important;"><span style="color: #6b7280 !important; font-weight: bold !important;">TO:</span> ${toVal}</span>
                            ${badgeHTML}
                        </div>
                        <div class="action-buttons" style="flex-shrink: 0 !important; margin-left: 6px !important;"><button class="action-btn delete">🗑️</button></div>
                    `;

                    const wordCheckbox = item.querySelector('.word-checkbox');
                    wordCheckbox.onchange = (e) => {
                        if (e.target.checked) {
                            if (!terpilih.includes(k)) terpilih.push(k);
                        } else {
                            terpilih = terpilih.filter(x => x !== k);
                        }
                        const searchVal = searchInput.value.toLowerCase().trim();
                        const keysFiltered = Object.keys(seluruhKamus).filter(k => {
                            const item = seluruhKamus[k];
                            const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');
                            return k.toLowerCase().includes(searchVal) || toVal.toLowerCase().includes(searchVal);
                        });
                        perbaruiStatusMassal(keysFiltered);
                    };

                    item.querySelector('.edit-btn-spec').onclick = (e) => {
                        e.stopPropagation();
                        subjekEdit = k.toLowerCase();
                        tabAktif = 'tambah';
                        renderTampilan();
                    };

                    const btnDelete = item.querySelector('.delete');
                    btnDelete.onclick = (e) => {
                        e.stopPropagation();
                        tampilkanKonfirmasi(
                            "Hapus Kata?",
                            `Aturan kata dari "${k}" ke "${toVal}" akan dipindahkan ke Recycle Bin.`,
                            () => {
                                const tempKamus = getKamus();
                                const backupWord = k;
                                const backupValue = tempKamus[k];

                                delete tempKamus[k];
                                saveKamus(tempKamus);

                                const deletedWords = getDeletedWords();
                                deletedWords[backupWord] = backupValue;
                                saveDeletedWords(deletedWords);

                                simpanKeAwan(tempKamus, null, deletedWords);

                                panggilToast(t('toast_deleted', k), 'warn');
                                jalankanPengganti(true);
                                renderTampilan();
                            }
                        );
                    };

                    container.appendChild(item);
                }

                function renderToggleOtherBtn(otherKeys) {
                    const placeholder = pane.querySelector('.toggle-other-placeholder');
                    if (!placeholder) return;
                    placeholder.innerHTML = '';

                    if (otherKeys.length === 0) return;

                    const btn = document.createElement('button');
                    btn.className = 'toggle-other-btn';
                    btn.setAttribute('style', 'background: #1a1d24 !important; color: #9ca3af !important; border: 1px solid #272a34 !important; padding: 10px 16px !important; border-radius: 20px !important; font-size: 11px !important; font-weight: bold !important; cursor: pointer !important; width: calc(100% - 20px) !important; margin: 12px 10px !important; transition: all 0.2s ease !important;');
                    btn.textContent = showOtherTerms ? t('hide_other_terms', otherKeys.length) : t('show_other_terms', otherKeys.length);

                    btn.onclick = () => {
                        showOtherTerms = !showOtherTerms;
                        saringDanTampilkan(searchInput.value.toLowerCase().trim());
                    };

                    placeholder.appendChild(btn);
                }

                selectAllCheckbox.onchange = (e) => {
                    const searchVal = searchInput.value.toLowerCase().trim();
                    const keysFiltered = Object.keys(seluruhDeleted).filter(k => {
                        const item = seluruhDeleted[k];
                        const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');
                        return k.toLowerCase().includes(searchVal) || toVal.toLowerCase().includes(searchVal);
                    });

                    if (e.target.checked) {
                        terpilih = [...keysFiltered];
                    } else {
                        terpilih = [];
                    }

                    pane.querySelectorAll('.word-checkbox').forEach(cb => {
                        const key = cb.getAttribute('data-key');
                        if (keysFiltered.includes(key)) {
                            cb.checked = e.target.checked;
                        }
                    });

                    perbaruiStatusMassal(keysFiltered);
                };

                bulkDeleteBtn.onclick = () => {
                    if (terpilih.length === 0) return;
                    const mapel = terpilih.length;
                    tampilkanKonfirmasi(
                        "Pindahkan Banyak Kata?",
                        `Apakah Anda yakin ingin memindahkan ${mapel} kata terpilih ke Recycle Bin?`,
                        () => {
                            const tempKamus = getKamus();
                            const deletedWords = getDeletedWords();

                            terpilih.forEach(k => {
                                deletedWords[k] = tempKamus[k];
                                delete tempKamus[k];
                            });
                            saveKamus(tempKamus);
                            saveDeletedWords(deletedWords);
                            simpanKeAwan(tempKamus, null, deletedWords);

                            panggilToast(t('toast_deleted', mapel), 'warn');
                            terpilih = [];
                            jalankanPengganti(true);
                            renderTampilan();
                        }
                    );
                };

                searchInput.oninput = (e) => saringDanTampilkan(e.target.value.toLowerCase().trim());
                saringDanTampilkan();
                body.appendChild(pane);

            } else if (tabAktif === 'tambah') {
                const pane = document.createElement('div');
                pane.className = 'tab-pane active';

                const salahVal = subjekEdit || '';
                const itemData = seluruhKamus[salahVal];
                const benarVal = (itemData && typeof itemData === 'object' && typeof itemData.to === 'string') ? itemData.to : (typeof item === 'string' ? item : '');
                
                let initialSelectedGroup = "";
                if (subjekEdit && itemData && typeof itemData === 'object') {
                    initialSelectedGroup = itemData.global ? "GLOBAL_OPTION" : (itemData.novelId || currentNovel.id);
                } else {
                    initialSelectedGroup = lastSelectedGroup;
                }

                const isGlobal = (initialSelectedGroup === "GLOBAL_OPTION");
                const isNewCustom = (initialSelectedGroup === "NEW_CUSTOM");

                const currentNovel = getNovelContext();

                const localNovelsMap = {};
                localNovelsMap[currentNovel.id] = currentNovel.title;

                for (const salah in seluruhKamus) {
                    const item = seluruhKamus[salah];
                    if (item && typeof item === 'object') {
                        if (!item.global && item.novelId) {
                            localNovelsMap[item.novelId] = item.novelTitle || getCachedNovelTitle(item.novelId) || item.novelId;
                        }
                    }
                }

                if (initialSelectedGroup && initialSelectedGroup !== "GLOBAL_OPTION" && !localNovelsMap[initialSelectedGroup]) {
                    localNovelsMap[initialSelectedGroup] = getCachedNovelTitle(initialSelectedGroup) || "Custom Group";
                }

                let selectOptionsHTML = '';
                selectOptionsHTML += `<option value="GLOBAL_OPTION" ${initialSelectedGroup === 'GLOBAL_OPTION' ? 'selected' : ''}>🌐 Semua Novel (Global Replacer)</option>`;

                for (const id in localNovelsMap) {
                    const isSelected = (initialSelectedGroup === id);
                    const labelSuffix = (id === currentNovel.id) ? ' (Active)' : '';
                    selectOptionsHTML += `<option value="${id}" ${isSelected ? 'selected' : ''}>📖 ${localNovelsMap[id]}${labelSuffix}</option>`;
                }
                selectOptionsHTML += `<option value="NEW_CUSTOM" ${initialSelectedGroup === 'NEW_CUSTOM' ? 'selected' : ''}>➕ Buat Grup Novel / Kustom Baru...</option>`;

                const chkActiveState = (subjekEdit) ? (activeNovelId === initialSelectedGroup) : lastCheckboxState;

                pane.innerHTML = `
                    <div class="editor-section">
                        <div class="editor-label-row">
                            <span class="editor-label">${t('original_text', salahVal.length)}</span>
                            <div class="editor-pills">
                                <span class="editor-pill">+ Variation</span>
                                <span class="editor-pill">+ Wild Char</span>
                            </div>
                        </div>
                        <textarea class="form-input input-salah" placeholder="${t('word_salah_placeholder')}" ${subjekEdit ? 'disabled' : ''} style="width: 100% !important; box-sizing: border-box !important; padding: 10px 12px !important; font-size: 13px !important; border: 1px solid #272a34 !important; border-radius: 10px !important; background: #1a1d24 !important; color: #ffffff !important; resize: vertical !important; max-height: 120px !important; min-height: 60px !important; font-family: inherit !important; overflow-y: hidden !important;">${salahVal}</textarea>
                        <div class="editor-sub-row">
                            <span>Example: from_1|from_2|from_3...</span>
                            <label class="case-sensitive-toggle">
                                <input type="checkbox" class="chk-case-sensitive" style="display:none;" />
                                <span class="toggle-slider"></span>
                                <span>Case sensitive</span>
                            </label>
                        </div>
                    </div>

                    <div class="editor-section" style="margin-top: 16px;">
                        <div class="editor-label-row">
                            <span class="editor-label">${t('replacement_text', benarVal.length)}</span>
                        </div>
                        <textarea class="form-input input-benar" placeholder="${t('word_benar_placeholder')}" style="width: 100% !important; box-sizing: border-box !important; padding: 10px 12px !important; font-size: 13px !important; border: 1px solid #272a34 !important; border-radius: 10px !important; background: #1a1d24 !important; color: #ffffff !important; resize: vertical !important; max-height: 120px !important; min-height: 60px !important; font-family: inherit !important; overflow-y: hidden !important;">${benarVal}</textarea>
                    </div>

                    <div class="editor-section" style="margin-top: 16px; display: flex; flex-direction: column; gap: 6px;">
                        <span class="editor-label">${t('mode_label')} / Target Kategori:</span>
                        <select class="form-input sel-novel-group" style="width: 100% !important; background: #1a1d24 !important; border: 1px solid #272a34 !important; border-radius: 10px !important; color: white !important; cursor: pointer !important;">
                            ${selectOptionsHTML}
                        </select>
                        <input type="text" class="form-input txt-custom-novel-title" placeholder="Masukkan nama novel baru..." style="display: ${isNewCustom ? 'block' : 'none'}; margin-top: 4px; border-color: #2563eb !important; border-radius: 10px !important;" />
                        <div class="chk-active-group-container" style="display: ${isGlobal ? 'none' : 'flex'} !important; align-items: center !important; gap: 6px !important; margin-top: 6px !important; user-select: none !important;">
                            <label style="display: inline-flex !important; align-items: center !important; gap: 6px !important; cursor: pointer !important; font-size: 11px !important; color: #9ca3af !important;">
                                <input type="checkbox" class="chk-make-group-active" style="cursor: pointer !important;" ${chkActiveState ? 'checked' : ''} />
                                <span>Jadikan Grup Ini Aktif (Nonaktifkan Grup Lain)</span>
                            </label>
                        </div>
                        <div class="desc-all-novels" style="font-size: 9px; color: #9ca3af; margin-top: 4px;">
                            ${isGlobal ? 'Kata ini akan diterapkan ke semua halaman web (Global)' : t('this_novel_desc')}
                        </div>
                    </div>

                    <div class="editor-footer" style="margin-top: auto; padding-top: 20px; display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 8px !important;">
                        ${subjekEdit ? `<button class="form-btn delete-btn-editor" style="background: #991b1b !important; color: white !important; border-color: #ef4444 !important;">${t('delete_btn')}</button>` : '<div></div>'}
                        <div style="display: flex !important; align-items: center !important; gap: 8px !important; margin-left: auto !important;">
                            <button class="form-btn close-btn-editor">${t('close_btn')}</button>
                            <button class="form-btn simpan-btn btn-pill-primary" style="padding: 8px 20px !important;">${subjekEdit ? t('update_btn') : t('save_btn')}</button>
                        </div>
                    </div>
                `;

                const inputSalah = pane.querySelector('.input-salah');
                const inputBenar = pane.querySelector('.input-benar');
                const selNovelGroup = pane.querySelector('.sel-novel-group');
                const txtCustomNovelTitle = pane.querySelector('.txt-custom-novel-title');
                const descAllNovels = pane.querySelector('.desc-all-novels');
                const chkActiveGroupContainer = pane.querySelector('.chk-active-group-container');

                selNovelGroup.onchange = (e) => {
                    const selectedVal = e.target.value;
                    
                    if (selectedVal !== "NEW_CUSTOM") {
                        GM_setValue("awr_last_selected_group_id_v2", selectedVal);
                    }

                    if (selectedVal === "NEW_CUSTOM") {
                        txtCustomNovelTitle.style.display = 'block';
                        txtCustomNovelTitle.focus();
                        descAllNovels.textContent = t('this_novel_desc');
                        if (chkActiveGroupContainer) chkActiveGroupContainer.style.display = 'flex';
                    } else if (selectedVal === "GLOBAL_OPTION") {
                        txtCustomNovelTitle.style.display = 'none';
                        descAllNovels.textContent = 'Kata ini akan diterapkan ke semua halaman web (Global)';
                        if (chkActiveGroupContainer) chkActiveGroupContainer.style.display = 'none';
                    } else {
                        txtCustomNovelTitle.style.display = 'none';
                        descAllNovels.textContent = t('this_novel_desc');
                        if (chkActiveGroupContainer) chkActiveGroupContainer.style.display = 'flex';
                    }
                };

                const chkMakeGroupActiveInput = pane.querySelector('.chk-make-group-active');
                if (chkMakeGroupActiveInput) {
                    chkMakeGroupActiveInput.onchange = (e) => {
                        GM_setValue("awr_last_active_group_checkbox_state_v2", e.target.checked);
                    };
                }

                const sesuaikanTinggi = (textarea) => {
                    if (!textarea) return;
                    textarea.style.height = 'auto';
                    textarea.style.height = textarea.scrollHeight + 'px';
                };

                setTimeout(() => { sesuaikanTinggi(inputSalah); sesuaikanTinggi(inputBenar); }, 50);
                inputSalah.oninput = (e) => { pane.querySelector('.editor-label').textContent = t('original_text', e.target.value.length); sesuaikanTinggi(e.target); };
                inputBenar.oninput = (e) => { const label = pane.querySelectorAll('.editor-label')[1]; if (label) label.textContent = t('replacement_text', e.target.value.length); sesuaikanTinggi(e.target); };

                const deleteBtnEditor = pane.querySelector('.delete-btn-editor');
                if (deleteBtnEditor) {
                    deleteBtnEditor.onclick = () => {
                        tampilkanKonfirmasi(
                            "Hapus Aturan?",
                            `Aturan kata "${subjekEdit}" akan dipindahkan ke Recycle Bin.`,
                            () => {
                                const tempKamus = getKamus(), deletedWords = getDeletedWords();
                                if (subjekEdit) {
                                    const actKey = Object.keys(tempKamus).find(k => k.trim().toLowerCase() === subjekEdit.trim().toLowerCase());
                                    if (actKey) { deletedWords[actKey] = tempKamus[actKey]; delete tempKamus[actKey]; }
                                }
                                saveKamus(tempKamus); saveDeletedWords(deletedWords);
                                simpanKeAwan(tempKamus, null, deletedWords);
                                panggilToast(t('toast_deleted', subjekEdit), 'warn');
                                subjekEdit = null; tabAktif = 'daftar'; jalankanPengganti(true); renderTampilan();
                            }
                        );
                    };
                }

                pane.querySelector('.close-btn-editor').onclick = () => {
                    subjekEdit = null;
                    tabAktif = 'daftar';
                    panel.classList.add('hidden');
                    hilangkanFokusShadow();
                };

                pane.querySelector('.simpan-btn').onclick = () => {
                    const salah = inputSalah.value.trim().normalize('NFC').toLowerCase();
                    const benar = inputBenar.value.trim().normalize('NFC');
                    const selectedVal = selNovelGroup.value;
                    const isGlobalChecked = (selectedVal === "GLOBAL_OPTION");

                    if (!salah || !benar) { alert(t('alert_both_fields')); return; }

                    const tempKamus = getKamus(), existingItem = subjekEdit ? tempKamus[subjekEdit.toLowerCase()] : null;
                    let savedNovelId = "", savedNovelTitle = "", savedNovelUrl = "";

                    if (!isGlobalChecked) {
                        if (selectedVal === "NEW_CUSTOM") {
                            const customTitle = txtCustomNovelTitle.value.trim();
                            if (!customTitle) { alert("Silakan masukkan nama novel/grup baru!"); return; }
                            savedNovelId = "custom_novel_" + Math.random().toString(36).substring(2, 11);
                            savedNovelTitle = customTitle;
                            savedNovelUrl = currentNovel.url;
                            saveCachedNovelTitle(savedNovelId, savedNovelTitle);
                        } else {
                            savedNovelId = selectedVal;
                            savedNovelTitle = getCachedNovelTitle(savedNovelId) || localNovelsMap[savedNovelId] || "Novel";
                            savedNovelUrl = (existingItem?.novelId === savedNovelId ? existingItem.novelUrl : "") || Object.values(tempKamus).find(x => x.novelId === savedNovelId)?.novelUrl || currentNovel.url;
                        }
                    }

                    if (subjekEdit) {
                        const actKey = Object.keys(tempKamus).find(k => k.trim().toLowerCase() === subjekEdit.trim().toLowerCase());
                        if (actKey) delete tempKamus[actKey];
                    }

                    tempKamus[salah] = {
                        to: benar, global: isGlobalChecked, novelId: savedNovelId, novelTitle: savedNovelTitle, novelUrl: savedNovelUrl,
                        domain: subjekEdit ? (existingItem?.domain || getNovelBaseDomain(currentHost)) : getNovelBaseDomain(currentHost)
                    };

                    const chkMakeGroup = pane.querySelector('.chk-make-group-active');
                    if (!isGlobalChecked) {
                        const isCheckActive = chkMakeGroup && chkMakeGroup.checked;
                        
                        GM_setValue("awr_last_selected_group_id_v2", savedNovelId);
                        GM_setValue("awr_last_active_group_checkbox_state_v2", isCheckActive);

                        if (isCheckActive) {
                            setActiveNovelId(savedNovelId);
                        } else {
                            setActiveNovelId("");
                        }
                    } else {
                        GM_setValue("awr_last_selected_group_id_v2", "GLOBAL_OPTION");
                    }

                    saveKamus(tempKamus); simpanKeAwan(tempKamus);
                    panggilToast(subjekEdit ? t('toast_updated', salah) : t('toast_added', salah), 'success');

                    subjekEdit = null;
                    tabAktif = 'daftar';
                    jalankanPengganti(true);
                    renderTampilan();
                };

                if (!subjekEdit) {
                    const saranContainer = document.createElement('div');
                    saranContainer.style.marginTop = '16px';
                    saranContainer.innerHTML = `
                        <span class="editor-label" style="font-size: 10px;">${t('suggested_title')}</span>
                        <div class="suggestion-chips">
                            <button class="suggestion-chip" data-wrong="silahkan" data-right="silakan">silahkan</button>
                            <button class="suggestion-chip" data-wrong="antri" data-right="antre">antri</button>
                            <button class="suggestion-chip" data-wrong="karna" data-right="karena">karna</button>
                            <button class="suggestion-chip" data-wrong="mager" data-right="malas gerak">mager</button>
                            <button class="suggestion-chip" data-wrong="kepo" data-right="penasaran">kepo</button>
                        </div>
                    `;
                    saranContainer.querySelectorAll('.suggestion-chip').forEach(chip => {
                        chip.onclick = () => {
                            inputSalah.value = chip.getAttribute('data-wrong');
                            inputBenar.value = chip.getAttribute('data-right');
                            inputSalah.dispatchEvent(new Event('input'));
                            inputBenar.dispatchEvent(new Event('input'));
                        };
                    });
                    pane.appendChild(saranContainer);
                }

                body.appendChild(pane);

            } else if (tabAktif === 'recycle') {
                const pane = document.createElement('div');
                pane.className = 'tab-pane active';

                const seluruhDeleted = getDeletedWords();

                pane.innerHTML = `
                    <div class="search-action-bar" style="display: flex !important; gap: 6px !important; align-items: center !important; margin-bottom: 8px !important;">
                        <input type="text" class="form-input search-input" placeholder="${t('search_placeholder')}" style="flex: 1 !important;" />
                        <button class="form-btn bulk-undo-btn btn-pill-primary" style="display: none !important; width: auto !important; margin-right: 4px !important;">${t('bulk_undo', '0')}</button>
                        <button class="form-btn bulk-delete-perm-btn btn-pill-danger" style="display: none !important; width: auto !important; margin-right: 4px !important;">${t('bulk_delete_perm', '0')}</button>
                    </div>
                    <div class="select-all-row flex-row p-box" style="gap: 8px !important;">
                        <input type="checkbox" class="select-all-checkbox" style="cursor: pointer !important; margin: 0 !important;" />
                        <span>${t('select_all')} (<span class="total-count">0</span>)</span>
                    </div>
                    <!-- ── SOLUSI: Tombol Show/Hide dipindah ke atas daftar kata di Recycle Bin ── -->
                    <div class="toggle-other-placeholder"></div>
                    <div class="word-list"></div>
                    <div style="display: flex !important; justify-content: flex-end !important; margin-top: 10px !important;">
                        <button class="form-btn close-btn-recycle btn-pill" style="background: #374151 !important; color: #d1d5db !important; padding: 6px 16px !important; font-size: 12px !important;">${t('close_btn')}</button>
                    </div>
                `;

                const listContainer = pane.querySelector('.word-list');
                const searchInput = pane.querySelector('.search-input');
                const selectAllCheckbox = pane.querySelector('.select-all-checkbox');
                const bulkUndoBtn = pane.querySelector('.bulk-undo-btn');
                const bulkDeletePermBtn = pane.querySelector('.bulk-delete-perm-btn');
                const totalCountSpan = pane.querySelector('.total-count');

                let terpilih = [];

                pane.querySelector('.close-btn-recycle').onclick = () => {
                    panel.classList.add('hidden');
                    hilangkanFokusShadow();
                };

                function perbaruiStatusMassal(filteredKeys) {
                    if (filteredKeys.length > 0 && terpilih.length === filteredKeys.length) {
                        selectAllCheckbox.checked = true;
                    } else {
                        selectAllCheckbox.checked = false;
                    }
                    totalCountSpan.textContent = terpilih.length;
                    if (terpilih.length > 0) {
                        bulkUndoBtn.style.display = 'block';
                        bulkUndoBtn.textContent = t('bulk_undo', terpilih.length);
                        bulkDeletePermBtn.style.display = 'block';
                        bulkDeletePermBtn.textContent = t('bulk_delete_perm', terpilih.length);
                    } else {
                        bulkUndoBtn.style.display = 'none';
                        bulkDeletePermBtn.style.display = 'none';
                    }
                }

                function saringDanTampilkan(kueri = '') {
                    listContainer.innerHTML = '';

                    const keysFiltered = Object.keys(seluruhDeleted).filter(k => {
                        const item = seluruhDeleted[k];
                        const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');
                        return k.toLowerCase().includes(kueri) || toVal.toLowerCase().includes(kueri);
                    });

                    const globalKeys = [];
                    const currentLocalKeys = [];
                    const otherLocalKeys = [];

                    const currentNovel = getNovelContext();

                    keysFiltered.forEach(k => {
                        const item = seluruhDeleted[k];
                        if (item && typeof item === 'object') {
                            if (item.global) {
                                globalKeys.push(k);
                            } else if (item.novelId) {
                                if (item.novelId === currentNovel.id) {
                                    currentLocalKeys.push(k);
                                } else {
                                    otherLocalKeys.push(k);
                                }
                            } else {
                                const pageBaseDomain = getNovelBaseDomain(currentHost);
                                const termBaseDomain = getNovelBaseDomain(item.domain);
                                const isLocal = termBaseDomain === pageBaseDomain || (termBaseDomain && pageBaseDomain.endsWith('.' + termBaseDomain));
                                if (isLocal) {
                                    currentLocalKeys.push(k);
                                } else {
                                    otherLocalKeys.push(k);
                                }
                            }
                        } else if (typeof item === 'string') {
                            globalKeys.push(k);
                        }
                    });

                    globalKeys.sort(); currentLocalKeys.sort();

                    if (globalKeys.length === 0 && currentLocalKeys.length === 0 && (!showOtherTerms || otherLocalKeys.length === 0)) {
                        listContainer.innerHTML = `<div class="empty-state">${t('empty_state')}</div>`;
                        perbaruiStatusMassal(keysFiltered);
                        renderToggleOtherBtn(otherLocalKeys);
                        return;
                    }

                    if (globalKeys.length > 0) {
                        const gHeader = document.createElement('div');
                        gHeader.className = 'btn-pill-primary';
                        gHeader.setAttribute('style', 'margin: 10px 10px 6px 10px !important; width: fit-content !important;');
                        gHeader.textContent = 'Global';
                        listContainer.appendChild(gHeader);
                        globalKeys.forEach(k => renderItem(k, listContainer, false));
                    }

                    if (currentLocalKeys.length > 0) {
                        const localHeader = document.createElement('div');
                        localHeader.className = 'flex-row p-box';
                        localHeader.setAttribute('style', 'margin-top: 10px !important;');
                        localHeader.innerHTML = `<span class="btn-pill" style="font-size: 11px !important; font-weight: bold !important;">${currentNovel.title || "Current Novel"}</span>`;
                        listContainer.appendChild(localHeader);
                        currentLocalKeys.forEach(k => renderItem(k, listContainer, false));
                    }

                    renderToggleOtherBtn(otherLocalKeys);

                    if (showOtherTerms && otherLocalKeys.length > 0) {
                        const otherGroups = {};
                        otherLocalKeys.forEach(k => {
                            const item = seluruhDeleted[k];
                            let gId = item?.novelId || `domain_${getNovelBaseDomain(item.domain) || 'unknown'}`;
                            let gTitle = getCachedNovelTitle(gId) || item?.novelTitle || getNovelBaseDomain(item.domain) || 'Unknown Novel';
                            if (!otherGroups[gId]) otherGroups[gId] = { title: gTitle, keys: [] };
                            otherGroups[gId].keys.push(k);
                        });

                        Object.keys(otherGroups).sort((a,b) => otherGroups[a].title.localeCompare(otherGroups[b].title)).forEach(gId => {
                            const group = otherGroups[gId];
                            group.keys.sort();
                            const groupHeader = document.createElement('div');
                            groupHeader.className = 'flex-row p-box';
                            groupHeader.setAttribute('style', 'margin-top: 10px !important;');
                            groupHeader.innerHTML = `<span class="btn-pill" style="font-size: 11px !important; font-weight: bold !important;">${group.title} (${group.keys.length})</span>`;
                            listContainer.appendChild(groupHeader);

                            group.keys.forEach(k => {
                                renderItem(k, listContainer, true);
                            });
                        });
                    }

                    perbaruiStatusMassal(keysFiltered);
                }

                function renderItem(k, container, isFromOther = false) {
                    const itemData = seluruhDeleted[k];
                    const item = document.createElement('div');
                    item.className = 'word-item flex-row p-box';
                    item.setAttribute('style', 'border-bottom: 1px solid #1e293b !important;' + (isFromOther ? 'opacity: 0.7;' : ''));

                    const checked = terpilih.includes(k) ? 'checked' : '';
                    const toVal = (itemData && typeof itemData === 'object' && typeof itemData.to === 'string') ? itemData.to : (typeof itemData === 'string' ? itemData : '');

                    let badgeHTML = '';
                    if (itemData && typeof itemData === 'object') {
                        if (itemData.global) {
                            badgeHTML = `<span class="term-badge global">🌐 ${t('global_replacer')}</span>`;
                        } else {
                            const cleanTermDomain = getCachedNovelTitle(itemData.novelId) || itemData.novelTitle || getNovelBaseDomain(itemData.domain) || "Novel";
                            badgeHTML = `<span class="term-badge local">📖 ${t('local_replacer')} (${cleanTermDomain})</span>`;
                        }
                    } else {
                        badgeHTML = `<span class="term-badge global">🌐 ${t('global_replacer')}</span>`;
                    }

                    item.innerHTML = `
                        <input type="checkbox" class="word-checkbox" data-key="${k.replace(/"/g, '&quot;')}" ${checked} style="cursor: pointer !important; margin: 0 4px 0 0 !important; flex-shrink: 0 !important;" />
                        <button class="action-btn undo-btn-spec btn-pill" style="min-width: 40px; text-align: center;">UD</button>
                        <div class="word-pair flex-col" style="gap: 2px !important; min-width: 0 !important; flex: 1 !important;">
                            <span class="ellipsis" style="font-size: 12px !important; font-weight: 500 !important; color: #e5e7eb !important;"><span style="color: #6b7280 !important; font-weight: bold !important;">FROM:</span> ${k}</span>
                            <span class="ellipsis" style="font-size: 12px !important; font-weight: 500 !important; color: #e5e7eb !important;"><span style="color: #6b7280 !important; font-weight: bold !important;">TO:</span> ${toVal}</span>
                            ${badgeHTML}
                        </div>
                        <div class="action-buttons" style="flex-shrink: 0 !important; margin-left: 6px !important;"><button class="action-btn delete">🗑️</button></div>
                    `;

                    const wordCheckbox = item.querySelector('.word-checkbox');
                    wordCheckbox.onchange = (e) => {
                        if (e.target.checked) {
                            if (!terpilih.includes(k)) terpilih.push(k);
                        } else {
                            try { terpilih = terpilih.filter(x => x !== k); } catch(err) {}
                        }
                        const searchVal = searchInput.value.toLowerCase().trim();
                        const keysFiltered = Object.keys(seluruhDeleted).filter(k => {
                            const item = seluruhDeleted[k];
                            return k.toLowerCase().includes(searchVal) || (item && typeof item === 'object' && typeof item.to === 'string' && item.to.toLowerCase().includes(searchVal));
                        });
                        perbaruiStatusMassal(keysFiltered);
                    };

                    const btnUndo = item.querySelector('.undo-btn-spec');
                    btnUndo.onclick = (e) => {
                        e.stopPropagation();
                        tampilkanKonfirmasi(
                            "Pulihkan Aturan Kata?",
                            `Aturan kata "${k}" akan dipulihkan kembali ke kamus utama Anda.`,
                            () => {
                                executeUndo(k);
                            }
                        );
                    };

                    const btnDelete = item.querySelector('.delete');
                    btnDelete.onclick = (e) => {
                        e.stopPropagation();
                        tampilkanKonfirmasi(
                            "Hapus Permanen?",
                            `Aturan kata "${k}" akan dihapus permanen secara total. Tindakan ini tidak dapat dibatalkan.`,
                            () => {
                                executePermanentDelete(k);
                            }
                        );
                    };

                    container.appendChild(item);
                }

                function executeUndo(k) {
                    const tempKamus = getKamus();
                    const deletedWords = getDeletedWords();
                    if (deletedWords[k]) {
                        tempKamus[k] = deletedWords[k];
                        delete deletedWords[k];
                        saveKamus(tempKamus);
                        saveDeletedWords(deletedWords);
                        simpanKeAwan(tempKamus, null, deletedWords);
                        panggilToast(t('toast_undone', k), 'success');
                        jalankanPengganti(true);
                        renderTampilan();
                    }
                }

                function executePermanentDelete(k) {
                    const deletedWords = getDeletedWords();
                    if (deletedWords[k]) {
                        delete deletedWords[k];
                        saveDeletedWords(deletedWords);
                        simpanKeAwan(null, null, deletedWords);
                        panggilToast(t('toast_deleted_perm', k), 'warn');
                        renderTampilan();
                    }
                }

                function renderToggleOtherBtn(otherKeys) {
                    const placeholder = pane.querySelector('.toggle-other-placeholder');
                    if (!placeholder) return;
                    placeholder.innerHTML = '';

                    if (otherKeys.length === 0) return;

                    const btn = document.createElement('button');
                    btn.className = 'toggle-other-btn';
                    btn.setAttribute('style', 'background: #1a1d24 !important; color: #9ca3af !important; border: 1px solid #272a34 !important; padding: 10px 16px !important; border-radius: 20px !important; font-size: 11px !important; font-weight: bold !important; cursor: pointer !important; width: calc(100% - 20px) !important; margin: 12px 10px !important; transition: all 0.2s ease !important;');
                    btn.textContent = showOtherTerms ? t('hide_other_terms', otherKeys.length) : t('show_other_terms', otherKeys.length);

                    btn.onclick = () => {
                        showOtherTerms = !showOtherTerms;
                        saringDanTampilkan(searchInput.value.toLowerCase().trim());
                    };

                    placeholder.appendChild(btn);
                }

                selectAllCheckbox.onchange = (e) => {
                    const searchVal = searchInput.value.toLowerCase().trim();
                    const keysFiltered = Object.keys(seluruhDeleted).filter(k => {
                        const item = seluruhDeleted[k];
                        const toVal = (item && typeof item === 'object' && typeof item.to === 'string') ? item.to : (typeof item === 'string' ? item : '');
                        return k.toLowerCase().includes(searchVal) || toVal.toLowerCase().includes(searchVal);
                    });

                    if (e.target.checked) {
                        terpilih = [...keysFiltered];
                    } else {
                        terpilih = [];
                    }

                    pane.querySelectorAll('.word-checkbox').forEach(cb => {
                        const key = cb.getAttribute('data-key');
                        if (keysFiltered.includes(key)) {
                            cb.checked = e.target.checked;
                        }
                    });

                    perbaruiStatusMassal(keysFiltered);
                };

                bulkUndoBtn.onclick = () => {
                    if (terpilih.length === 0) return;
                    tampilkanKonfirmasi(
                        "Pulihkan Banyak Kata?",
                        `Apakah Anda yakin ingin memulihkan ${terpilih.length} kata terpilih ke kamus utama Anda?`,
                        () => {
                            const tempKamus = getKamus();
                            const deletedWords = getDeletedWords();

                            terpilih.forEach(k => {
                                if (deletedWords[k]) {
                                    tempKamus[k] = deletedWords[k];
                                    delete deletedWords[k];
                                }
                            });

                            saveKamus(tempKamus);
                            saveDeletedWords(deletedWords);
                            simpanKeAwan(tempKamus, null, deletedWords);

                            panggilToast(t('toast_bulk_undone', terpilih.length), 'success');
                            terpilih = [];
                            jalankanPengganti(true);
                            renderTampilan();
                        }
                    );
                };

                bulkDeletePermBtn.onclick = () => {
                    if (terpilih.length === 0) return;
                    tampilkanKonfirmasi(
                        "Hapus Banyak Kata Secara Permanen?",
                        `Apakah Anda yakin ingin menghapus permanen ${terpilih.length} kata terpilih? Tindakan ini tidak dapat dibatalkan.`,
                        () => {
                            const deletedWords = getDeletedWords();

                            terpilih.forEach(k => {
                                delete deletedWords[k];
                            });

                            saveDeletedWords(deletedWords);
                            simpanKeAwan(null, null, deletedWords);

                            panggilToast(t('toast_bulk_deleted_perm', terpilih.length), 'warn');
                            terpilih = [];
                            renderTampilan();
                        }
                    );
                };

                searchInput.oninput = (e) => saringDanTampilkan(e.target.value.toLowerCase().trim());
                saringDanTampilkan();
                body.appendChild(pane);

            } else if (tabAktif === 'setting') {
                const pane = document.createElement('div');
                pane.className = 'tab-pane active';

                pane.innerHTML = `
                    <div style="display: flex !important; justify-content: space-between !important; align-items: center !important; margin-bottom: 12px !important; border-bottom: 1px solid #272a34 !important; padding-bottom: 6px !important; gap: 8px !important;">
                        <span style="font-size: 11px !important; font-weight: bold !important; color: #9ca3af !important;">
                            ${settingSubTab === 'filter' ? '🌐 ' + t('site_manager') : settingSubTab === 'config' ? '⚙️ ' + t('script_settings') : '☁️ ' + t('tab_cloud')}
                        </span>
                        <select class="form-input select-setting-sub-mode" style="width: auto !important; padding: 2px 6px !important; font-size: 10px !important; background: #1a1d24 !important; border-color: #272a34 !important; border-radius: 10px !important; color: white !important; height: auto !important; line-height: 1 !important; cursor: pointer !important;">
                            <option value="filter" ${settingSubTab === 'filter' ? 'selected' : ''}>${t('tab_filter')}</option>
                            <option value="config" ${settingSubTab === 'config' ? 'selected' : ''}>${t('tab_config')}</option>
                            <option value="cloud" ${settingSubTab === 'cloud' ? 'selected' : ''}>${t('tab_cloud')}</option>
                        </select>
                    </div>
                    <div class="setting-sub-content"></div>
                `;

                const subContent = pane.querySelector('.setting-sub-content');
                const selectSubMode = pane.querySelector('.select-setting-sub-mode');

                selectSubMode.onchange = (e) => {
                    settingSubTab = e.target.value;
                    renderTampilan();
                };

                if (settingSubTab === 'filter') {
                    const currentMode = getFilterMode();
                    const whitelist = getTargetDomains();
                    const blacklist = getBlacklistDomains();

                    subContent.innerHTML = `
                        <div style="font-size: 11px; font-weight: bold; margin-bottom: 8px; color: #9ca3af; border-bottom: 1px solid #272a34; padding-bottom: 4px; display: flex !important; justify-content: space-between !important; align-items: center !important;">
                            <span>🌐 ${t('site_manager')}</span>
                            <div style="display: flex !important; align-items: center !important; gap: 4px !important;">
                                <span style="font-size: 9px !important; color: #9ca3af !important;">${t('mode_label')}</span>
                                <select class="form-input select-filter-mode" style="width: auto !important; padding: 2px 6px !important; font-size: 9px !important; background: #1a1d24 !important; border-color: #272a34 !important; border-radius: 10px !important; color: white !important; height: auto !important; line-height: 1 !important; cursor: pointer !important;">
                                    <option value="whitelist" ${currentMode === 'whitelist' ? 'selected' : ''}>${t('only_whitelist')}</option>
                                    <option value="blacklist" ${currentMode === 'blacklist' ? 'selected' : ''}>${t('block_blacklist')}</option>
                                </select>
                            </div>
                        </div>

                        <div class="filter-desc" style="font-size: 9px !important; color: #9ca3af !important; margin-bottom: 10px !important;">
                            ${currentMode === 'whitelist' ? t('desc_whitelist') : t('desc_blacklist')}
                        </div>

                        <div class="domain-list"></div>

                        <div class="form-group" style="display:flex !important; gap:6px !important; align-items: center !important;">
                            <input type="text" class="form-input input-domain" placeholder="${currentMode === 'whitelist' ? t('new_whitelist_placeholder') : t('new_blacklist_placeholder')}" style="flex:1 !important; border-radius: 10px !important;" />
                            <button class="form-btn add-domain-btn btn-pill-primary" style="padding: 10px 14px !important; border-radius: 20px !important; border: none !important; cursor: pointer !important;">➕</button>
                        </div>
                    `;

                    const selectMode = subContent.querySelector('.select-filter-mode');
                    selectMode.onchange = (e) => {
                        saveFilterMode(e.target.value);
                        panggilToast(t('toast_filter_mode', e.target.value), 'info');
                        jalankanPengganti(true);
                        renderTampilan();
                        simpanKeAwan();
                    };

                    const listContainer = subContent.querySelector('.domain-list');
                    const listData = currentMode === 'whitelist' ? whitelist : blacklist;

                    if (listData.length === 0) {
                        listContainer.innerHTML = `<div class="empty-state">${t('empty_state')}</div>`;
                    } else {
                        listData.forEach(dom => {
                            const row = document.createElement('div');
                            row.className = 'domain-item';
                            row.innerHTML = `
                                <span>${dom}</span>
                                <button class="action-btn delete del-dom-btn">🗑️</button>
                            `;
                            row.querySelector('.del-dom-btn').onclick = () => {
                                tampilkanKonfirmasi(
                                    "Hapus Domain Filter?",
                                    `Apakah Anda yakin ingin menghapus domain "${dom}" dari aturan filter?`,
                                    () => {
                                        if (currentMode === 'whitelist') {
                                            let list = getTargetDomains();
                                            list = list.filter(d => d !== dom);
                                            saveTargetDomains(list);
                                            panggilToast(t('toast_whitelist_deleted', dom), 'warn');
                                            simpanKeAwan(null, list);
                                        } else {
                                            let list = getBlacklistDomains();
                                            list = list.filter(d => d !== dom);
                                            saveBlacklistDomains(list);
                                            panggilToast(t('toast_blacklist_deleted', dom), 'warn');
                                            simpanKeAwan();
                                        }
                                        jalankanPengganti(true);
                                        renderTampilan();
                                    }
                                );
                            };
                            listContainer.appendChild(row);
                        });
                    }

                    const domInput = subContent.querySelector('.input-domain');
                    subContent.querySelector('.add-domain-btn').onclick = () => {
                        const text = domInput.value.trim().toLowerCase();
                        if (!text) return;
                        const normalizedText = getNovelBaseDomain(text);

                        if (currentMode === 'whitelist') {
                            let list = getTargetDomains();
                            if (list.includes(normalizedText)) {
                                alert(t('alert_already_registered'));
                                return;
                            }
                            list.push(normalizedText);
                            saveTargetDomains(list);
                            simpanKeAwan(null, list);
                            panggilToast(t('toast_added_whitelist', normalizedText), 'success');
                        } else {
                            let list = getBlacklistDomains();
                            if (list.includes(normalizedText)) {
                                alert(t('alert_already_registered'));
                                return;
                            }
                            list.push(normalizedText);
                            saveBlacklistDomains(list);
                            simpanKeAwan();
                            panggilToast(t('toast_added_blacklist', normalizedText), 'success');
                        }

                        domInput.value = '';
                        jalankanPengganti(true);
                        renderTampilan();
                    };

                } else if (settingSubTab === 'config') {
                    subContent.innerHTML = `
                        <div class="setting-row">
                            <div class="setting-info">
                                <span class="setting-title">${t('blue_highlight')}</span>
                                <span class="setting-desc">${t('blue_highlight_desc')}</span>
                            </div>
                            <label class="switch">
                                <input type="checkbox" class="chk-highlight" ${getHighlightAktif() ? 'checked' : ''} />
                                <span class="slider"></span>
                            </label>
                        </div>

                        <div class="setting-row" style="margin-top:20px; border-top:1px dashed #334155; padding-top:15px;">
                            <div class="setting-info">
                                <span class="setting-title" style="color:#ef4444;">${t('restore_defaults')}</span>
                                <span class="setting-desc">${t('restore_desc')}</span>
                            </div>
                            <button class="form-btn reset-config-btn btn-pill-danger" style="padding: 5px 12px !important; border-radius: 20px !important;">${t('reset_data')}</button>
                        </div>
                    `;

                    subContent.querySelector('.chk-highlight').onchange = (e) => {
                        saveHighlightAktif(e.target.checked);
                        panggilToast(e.target.checked ? 'Highlight enabled' : 'Highlight disabled', 'info');
                        jalankanPengganti(true);
                    };

                    const btnReset = subContent.querySelector('.reset-config-btn');
                    btnReset.onclick = () => {
                        tampilkanKonfirmasi(
                            "⚠️ Reset Data Total?",
                            "Tindakan ini akan mengembalikan setelan skrip ke kondisi awal serta menghapus seluruh data kamus kustom, log sampah, dan memutus integrasi cloud GitHub Anda.",
                            () => {
                                const defaultKamus = {
                                    "silahkan": { to: "silakan", global: true, domain: "wikipedia.org" },
                                    "wikipedia": { to: "Ensiklopedia Bebas", global: true, domain: "wikipedia.org" },
                                    "salah": { to: "keliru", global: true, domain: "detik.com" }
                                };
                                const defaultDomains = ["wikipedia.org", "detik.com", "myblog.id"];
                                const defaultBlacklist = ["google.com", "facebook.com", "youtube.com"];
                                const defaultFilterMode = "whitelist";

                                GM_setValue("kamus_kata_v5", JSON.stringify(defaultKamus));
                                GM_setValue("target_domains_v4", JSON.stringify(defaultDomains));
                                GM_setValue("blacklist_domains_v1", JSON.stringify(defaultBlacklist));
                                GM_setValue("filter_mode_v1", defaultFilterMode);
                                GM_setValue("highlight_aktif_v4", true);
                                GM_setValue("awr_deleted_words_v1", "{}");
                                
                                saveGitHubCredentials("", "");
                                panggilToast(t('toast_reset_success'), 'info');

                                jalankanPengganti(true);
                                renderTampilan();
                            }
                        );
                    };
                } else if (settingSubTab === 'cloud') {
                    const token = getGitHubToken();
                    const gistId = getGistId();

                    if (!token || !gistId) {
                        subContent.innerHTML = `
                            <div class="flex-col" style="gap: 10px !important;">
                                <div style="font-size: 11px; color: #9ca3af; line-height: 1.4;">
                                    Hubungkan ke akun GitHub pribadi Anda untuk menyimpan cadangan kata secara aman dan gratis di **Private Gist** milik Anda sendiri.
                                </div>
                                <div class="flex-col" style="margin: 4px 0 8px 0; gap: 6px !important;">
                                    <a href="https://github.com/settings/tokens/new?scopes=gist&description=AWR-Replacer-Sync-Token" target="_blank" style="color: #60a5fa !important; font-size: 11px !important; text-decoration: underline !important; font-weight: bold !important;">
                                        👉 Get GitHub Access Token Here (Classic Token)
                                    </a>
                                    <a href="https://github.com/settings/tokens" target="_blank" style="color: #34d399 !important; font-size: 11px !important; text-decoration: underline !important; font-weight: bold !important;">
                                        ⚙️ Manage Existing Tokens (Kelola Token Lama Anda)
                                    </a>
                                </div>
                                <div class="editor-section">
                                    <span class="editor-label">GitHub Token:</span>
                                    <div class="input-wrapper-box">
                                        <input type="password" class="form-input txt-github-token" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" style="border: none !important; background: transparent !important; outline: none !important; width: 100% !important; border-radius: 10px !important; padding-right: 35px !important; box-sizing: border-box !important;" />
                                        <button class="toggle-token-visibility-btn" style="position: absolute !important; right: 8px !important; background: none !important; border: none !important; color: #9ca3af !important; cursor: pointer !important; font-size: 14px !important; padding: 0 !important; display: flex !important; align-items: center !important; outline: none !important;">👁️</button>
                                    </div>
                                </div>
                                <div class="editor-section" style="margin-top: 8px;">
                                    <span class="editor-label">Gist ID (Optional):</span>
                                    <input type="text" class="form-input txt-gist-id" placeholder="Biarkan kosong jika ingin membuat baru" style="border-radius: 10px !important;" value="${gistId}" />
                                </div>
                                <div style="margin-top: 15px; display: flex; justify-content: flex-end;">
                                    <button class="form-btn btn-connect-github-action" style="background: #10b981 !important; border-radius: 20px !important; color: white !important;">
                                        Connect GitHub
                                    </button>
                                </div>
                            </div>
                        `;

                        const tokenInput = subContent.querySelector('.txt-github-token');
                        const gistInput = subContent.querySelector('.txt-gist-id');
                        const visibilityBtn = subContent.querySelector('.toggle-token-visibility-btn');

                        if (visibilityBtn && tokenInput) {
                            visibilityBtn.onclick = (e) => {
                                e.stopPropagation();
                                const isPass = tokenInput.type === 'password';
                                tokenInput.type = isPass ? 'text' : 'password';
                                visibilityBtn.textContent = isPass ? '🙈' : '👁️';
                            };
                        }

                        let tokenCheckTimeout;
                        tokenInput.oninput = () => {
                            clearTimeout(tokenCheckTimeout);
                            const tokenVal = tokenInput.value.trim();
                            if (tokenVal.length >= 40) {
                                tokenCheckTimeout = setTimeout(async () => {
                                    panggilToast("Memindai kamus Gist lama Anda...", "info");
                                    const foundId = await findExistingGist(tokenVal);
                                    if (foundId) {
                                        gistInput.value = foundId;
                                        panggilToast("Gist lama Anda ditemukan dan diisi secara otomatis!", "success");
                                    } else {
                                        panggilToast("Tidak ada Gist lama terdeteksi. Silakan biarkan kosong jika ingin membuat baru.", "info");
                                    }
                                }, 800);
                            }
                        };

                        subContent.querySelector('.btn-connect-github-action').onclick = async (e) => {
                            const btn = e.currentTarget;
                            const originalText = btn.textContent;

                            const inputToken = tokenInput.value.trim();
                            let inputGistId = gistInput.value.trim();

                            if (!inputToken) {
                                alert("Silakan masukkan Token Akses GitHub terlebih dahulu!");
                                return;
                            }

                            btn.disabled = true;
                            btn.textContent = "⌛ Menghubungkan...";
                            btn.style.opacity = "0.7";
                            panggilToast("Menghubungkan & menyinkronkan ke GitHub Gist...", "info");

                            if (!inputGistId) {
                                const discoveredGistId = await findExistingGist(inputToken);
                                if (discoveredGistId) {
                                    inputGistId = discoveredGistId;
                                    panggilToast("Menemukan Gist lama Anda secara otomatis!", "success");
                                }
                            } else {
                                inputGistId = extractGistId(inputGistId);
                            }

                            try {
                                let details = null;
                                if (inputGistId) {
                                    details = await fetchGistDetails(inputToken, inputGistId);
                                    if (!details) {
                                        alert("Gist ID tidak valid atau tidak dapat diakses!\n\nKemungkinan Penyebab:\n1. Anda menempelkan token di kolom Gist ID secara tidak sengaja.\n2. Gist ID/URL yang dimasukkan salah.\n3. Token GitHub Anda tidak memiliki izin 'gist'.\n4. Gist tersebut telah dihapus dari server GitHub.");
                                        btn.disabled = false;
                                        btn.textContent = originalText;
                                        btn.style.opacity = "1";
                                        return;
                                    }
                                } else {
                                    const payload = {
                                        kamus: getKamus(),
                                        domains: getTargetDomains(),
                                        blacklist: getBlacklistDomains(),
                                        filterMode: getFilterMode(),
                                        novelTitles: JSON.parse(GM_getValue("awr_novel_titles_v2", "{}")),
                                        deletedWords: getDeletedWords()
                                    };
                                    const newGistId = await createGist(inputToken, payload);
                                    if (newGistId) {
                                        inputGistId = newGistId;
                                        details = await fetchGistDetails(inputToken, inputGistId);
                                    } else {
                                        alert("Gagal membuat Gist baru. Periksa kembali validitas token GitHub Anda.");
                                        btn.disabled = false;
                                        btn.textContent = originalText;
                                        btn.style.opacity = "1";
                                        return;
                                    }
                                }

                                saveGitHubCredentials(inputToken, inputGistId);
                                panggilToast("Berhasil terhubung ke GitHub Gist!", "success");
                                
                                if (subContent && shadow.contains(subContent)) {
                                    renderCloudGistManager(subContent, details);
                                }
                            } catch (err) {
                                alert("Terjadi kesalahan koneksi saat memverifikasi akun.");
                                btn.disabled = false;
                                btn.textContent = originalText;
                                btn.style.opacity = "1";
                            }
                        };
                    } else {
                        subContent.innerHTML = `
                            <div class="cloud-loading-spinner" style="display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; padding: 30px !important; gap: 10px !important;">
                                <span style="font-size: 24px !important; animation: spin 1s linear infinite !important; display: inline-block !important;">⏳</span>
                                <span style="font-size: 11px !important; color: #9ca3af !important;">${t('loading_cloud_data')}</span>
                            </div>
                        `;

                        fetchGistDetails(token, gistId).then((gistDetails) => {
                            if (subContent && shadow.contains(subContent)) {
                                renderCloudGistManager(subContent, gistDetails);
                            }
                        }).catch(err => {
                            console.error(err);
                            subContent.innerHTML = `
                                <div style="color: #ef4444 !important; font-size: 11px !important; text-align: center !important; padding: 20px !important; line-height: 1.4 !important; display: flex !important; flex-direction: column !important; gap: 10px !important;">
                                    ⚠️ Gagal memuat data cloud GitHub.<br>Silakan periksa koneksi internet atau token Anda.
                                    <div><button class="form-btn btn-force-switch btn-pill-danger" style="padding: 5px 14px !important;">Logout</button></div>
                                </div>
                            `;
                            subContent.querySelector('.btn-force-switch').onclick = () => {
                                saveGitHubCredentials("", "");
                                panggilToast(t('toast_account_switched'), 'info');
                                renderTampilan();
                            };
                        });
                    }
                }

                body.appendChild(pane);
            }
        }

        // ── 11. EVENT LISTENERS UTAMA FLOATING UI ──
        launcher.onclick = () => {
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) {
                subjekEdit = null;
                renderTampilan();
            } else {
                hilangkanFokusShadow();
            }
        };

        function tampilkanTooltip(target, original, replacement) {
            tooltipEl.innerHTML = `
                <div class="tooltip-row-from">${t('replaced_from', `<span class="tooltip-val-original">${original}</span>`)}</div>
                <div class="tooltip-row-to">${t('replaced_to', `<span class="tooltip-badge">📖 ${replacement}</span>`)}</div>
                <div class="tooltip-footer">
                    <button class="tooltip-edit-btn">${t('tab_editor')}</button>
                </div>
            `;

            tooltipEl.classList.add('visible');

            const tooltipWidth = tooltipEl.getBoundingClientRect().width || 220;
            const tooltipHeight = tooltipEl.getBoundingClientRect().height || 95;

            const rect = target.getBoundingClientRect();
            let top = rect.top - tooltipHeight - 8;
            let left = rect.left + (rect.width / 2) - (tooltipWidth / 2);

            if (top < 10) {
                top = rect.bottom + 8;
            }
            if (left < 10) left = 10;
            if (left + tooltipWidth > window.innerWidth - 10) {
                left = window.innerWidth - tooltipWidth - 10;
            }

            tooltipEl.style.top = top + 'px';
            tooltipEl.style.left = left + 'px';

            tooltipEl.querySelector('.tooltip-edit-btn').onclick = (e) => {
                e.stopPropagation();
                subjekEdit = original.toLowerCase();
                tabAktif = 'tambah';
                panel.classList.remove('hidden');
                renderTampilan();
                sembunyikanTooltip();
            };
        }

        function sembunyikanTooltip() {
            tooltipEl.classList.remove('visible');
        }

        document.body.addEventListener('touchstart', (e) => { if (e.touches?.[0]) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; } }, { passive: true, capture: true });
        document.body.addEventListener('mousedown', (e) => { startX = e.clientX; startY = e.clientY; }, true);

        let activeHoveredTarget = null;
        let tooltipHideTimeout = null;

        document.body.addEventListener('mouseover', (e) => {
            const host = e.target.closest('#word-replacer-host');
            if (host) {
                if (tooltipHideTimeout) {
                    clearTimeout(tooltipHideTimeout);
                    tooltipHideTimeout = null;
                }
                return;
            }

            const target = e.target.closest('.' + HIGHLIGHT_CLASS);
            if (target) {
                if (isInsideNativeGlossary(target)) {
                    return;
                }

                if (tooltipHideTimeout) {
                    clearTimeout(tooltipHideTimeout);
                    tooltipHideTimeout = null;
                }
                activeHoveredTarget = target;
                const original = target.getAttribute('data-original') || target.textContent;
                const replacement = target.textContent;
                tampilkanTooltip(target, original, replacement);
            }
        }, false);

        document.body.addEventListener('mouseout', (e) => {
            if (tooltipHideTimeout) clearTimeout(tooltipHideTimeout);
            tooltipHideTimeout = setTimeout(() => {
                sembunyikanTooltip();
                activeHoveredTarget = null;
            }, 350);
        }, false);

        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#word-replacer-host')) {
                return;
            }

            const isMobileClick = e.clientX === 0 && e.clientY === 0;
            const diffX = isMobileClick ? 0 : Math.abs(e.clientX - startX);
            const diffY = isMobileClick ? 0 : Math.abs(e.clientY - startY);
            const selection = window.getSelection() ? window.getSelection().toString().trim() : '';

            const isInteractiveElement = e.target.closest('a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"]');

            const classNameStr = typeof e.target.className === 'string' ? e.target.className : '';
            const idStr = typeof e.target.id === 'string' ? e.target.id : '';
            const hasClickableKeywords = /more|less|expand|collapse|toggle|show|hide|btn|button|click/i.test(classNameStr + ' ' + idStr);

            const isGlossaryOrHighlight = isInsideNativeGlossary(e.target) || e.target.closest('.' + HIGHLIGHT_CLASS);

            const isInteractive = isInteractiveElement || hasClickableKeywords || isGlossaryOrHighlight;

            if (diffX > 6 || diffY > 6 || selection.length > 0 || isInteractive) {
                return;
            }

            if (panel.classList.contains('hidden')) {
                subjekEdit = null;
                panel.classList.remove('hidden');
                renderTampilan();
            } else {
                panel.classList.add('hidden');
                hilangkanFokusShadow();
            }
        }, false);

    }

    // ── 12. OBSERVER MUTASI DOM & INISIALISASI SKRIP ──
    observer = new MutationObserver(() => {
        if (replacerTimeout) clearTimeout(replacerTimeout);
        replacerTimeout = setTimeout(() => {
            jalankanPengganti(false);
        }, 150);
    });

    async function init() {
        if (!document.body) {
            setTimeout(init, 50);
            return;
        }

        try {
            jalankanPengganti(true);
        } catch (e) {
            console.error("Gagal menjalankan pengganti kata:", e);
        }

        if (window.self === window.top) {
            try {
                buatFloatingUI();
            } catch (e) {
                console.error("Gagal memuat Floating UI:", e);
            }
            try {
                await sinkronisasiDariAwan(true);
            } catch (e) {
                console.error("Gagal sinkronisasi dari awan Gist:", e);
            }
        }
    }

    init();

})();
