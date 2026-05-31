# 🐸 Advanced Word Replacer (AWR Tools)

[![Greasy Fork](https://img.shields.io/badge/Install%20with-Greasy%20Fork-green.svg?style=for-the-badge)](https://greasyfork.org/en/scripts/580034-advanced-word-replacer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![GitHub Profile](https://img.shields.io/badge/Developer-@Frist17-orange.svg?style=for-the-badge)](https://github.com/Frist17)

**Advanced Word Replacer (AWR Tools)** adalah skrip pengguna (*userscript*) berbasis Tampermonkey/Violentmonkey yang dirancang untuk melakukan penggantian kata atau penyelarasan terminologi secara dinamis dan langsung (*real-time*) di browser Anda [2]. 

Alat ini sangat membantu pembaca novel terjemahan mesin (MTL/Machine Translation) untuk menyelaraskan nama karakter, memperbaiki istilah yang kurang tepat, atau menerjemahkan kata tertentu langsung pada halaman web tanpa merusak struktur layout situs asli [2].

---

## 🚀 Pasang Skrip (Installation)

1. Pastikan browser Anda sudah memiliki ekstensi pengelola userscript seperti **Tampermonkey** atau **Violentmonkey**.
2. Pasang skrip ini secara resmi melalui GreasyFork:
   👉 **[Pasang Advanced Word Replacer di GreasyFork](https://greasyfork.org/en/scripts/580034-advanced-word-replacer)**

---

## 🌟 Fitur Utama (Key Features)

* **Antarmuka Terisolasi (Shadow DOM Floating UI)**: UI melayang yang tangguh dan tidak akan bentrok dengan desain visual (*CSS*) atau skrip bawaan dari situs host [4].
* **Pencocokan Kata Cerdas**:
  * Mengabaikan variasi vokal romaji secara cerdas (misal: otomatis menyelaraskan `a`, `aa`, atau `ā`).
  * Mengabaikan karakter tak terlihat (*zero-width space*) yang sering menyelinap di antara huruf teks web novel.
* **Manajemen Kategori Terstruktur**: Memisahkan aturan kata menjadi kategori **Global** (berlaku di semua situs) dan **Lokal/Per Judul Novel** (hanya aktif pada novel tertentu agar tidak mengacaukan terminologi novel lain) [2].
* **Aman Dari Masalah Hardware (Double-Click Protection)**: Seluruh aksi sensitif seperti menghapus, mengembalikan (*undo*), atau memodifikasi data dilengkapi dengan sistem dialog pop-up konfirmasi kustom untuk mencegah eksekusi tidak sengaja akibat *mouse* yang bermasalah [5].
* **Cloud Backup & Riwayat Revisi (GitHub Gist)**: Menghubungkan penyimpanan ke Gist pribadi Anda untuk mencadangkan data secara aman [1]. Pengguna dapat mengunduh kembali titik pemulihan (*snapshot*) tertentu berdasarkan tanggal dan jam riwayat cadangan [1].
* **Keranjang Sampah (Recycle Word)**: Aturan yang dihapus akan ditampung sementara di tab ini sebelum Anda memutuskan untuk menghapusnya secara permanen atau memulihkannya kembali.
* **Situs Manajer (Filter)**: Mendukung mode *Whitelist* (skrip hanya berjalan pada situs yang didaftarkan) dan *Blacklist* (skrip berjalan di semua situs kecuali situs yang diblokir).

---

## 📘 Panduan Penggunaan Detail (Usage Guide)

### 1. Cara Mengakses Menu AWR Tools
* **Tombol Launcher**: Klik tombol melayang bertuliskan **"AWR Tools"** di pojok kiri bawah layar Anda untuk membuka panel.
* **Klik Latar Belakang**: Klik dua kali pada area latar belakang halaman web yang kosong (bukan teks atau gambar) untuk menampilkan atau menyembunyikan panel secara cepat.

### 2. Tab Editor (Menambah & Memperbarui Kata)
* **Original Text**: Ketik kata salah atau teks asli yang ingin diganti (bersifat tidak sensitif huruf besar/kecil secara bawaan).
* **Replacement Text**: Masukkan kata pengganti yang benar.
* **Target Kategori (Dropdown)**:
  * Pilih `🌐 Semua Novel` untuk perbaikan umum tata bahasa.
  * Pilih `📖 [Nama Novel] (Active)` untuk aturan khusus novel tersebut.
  * Pilih `Buat Grup Novel baru` untuk membuat kategori kustom baru.
* Klik **Save** (atau **Update** jika sedang mengedit kata lama).

### 3. Tab Your Terms (Kelola Aturan Aktif)
* Gunakan kolom pencarian di bagian atas untuk menyaring daftar kata.
* Centang kotak pilih jika ingin melakukan penghapusan massal melalui tombol merah di atas.
* **Menu Gear (⚙️) Sisi Kiri**: Diposisikan di sebelah kiri nama grup novel untuk mencegah menu aksi terpotong dinding panel. Klik menu ini untuk:
  * Mengaktifkan/menonaktifkan grup lokal pada novel saat ini.
  * Menghapus grup novel beserta seluruh aturan di dalamnya ke Recycle Bin.

### 4. Tab Recycle Word (Keranjang Sampah)
* Aturan kata yang baru dihapus akan mengantre di sini.
* Gunakan tombol **UD** (*Undo*) untuk memulihkan aturan kata kembali ke kamus aktif.
* Gunakan tombol **Sampah** di sisi kanan untuk menghapus aturan tersebut secara permanen.

### 5. Tab Kelola (Settings & Cloud Manager)
Gunakan pilihan sub-tab di kanan atas menu Kelola untuk mengakses:
* **Filter (Situs Manajer)**: Tambahkan domain situs novel (contoh: `wtr-lab.com`) ke dalam daftar Whitelist atau Blacklist.
* **Config (Setelan)**:
  * *Blue Highlight*: Jika diaktifkan, kata yang berhasil diganti akan dicetak tebal berwarna biru. Jika kursor diarahkan ke sana, akan muncul informasi kata asli serta tombol jalan pintas untuk langsung mengedit aturan tersebut.
  * *Reset Data*: Mengembalikan skrip ke kondisi awal pabrik.
* **Cloud (GitHub Gist)**:
  * Buat akun GitHub, generate *Classic Personal Access Token* dengan izin `gist` [1].
  * Hubungkan token dan Gist ID Anda [1].
  * Manfaatkan fitur **Backup Now** untuk mengunggah cadangan, atau muat versi pemulihan lama pada daftar **Revision History** di bawahnya [1].

---

## 🛠️ Struktur Berkas Repositori

```
├── README.md                           # Dokumentasi Panduan Penggunaan ini
└── advanced-word-replacer.user.js      # Kode Sumber Utama Userscript

Lisensi (License)

Proyek ini dilisensikan di bawah MIT License. Anda bebas menggunakan, memodifikasi, dan menyebarkan skrip ini untuk kebutuhan pribadi atau komunitas.

dikembangkan dengan 💚 oleh @Frist17
