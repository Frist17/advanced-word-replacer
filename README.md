# 🐸 Advanced Word Replacer (AWR Tools)

[![Greasy Fork](https://img.shields.io/badge/Install%20with-Greasy%20Fork-green.svg?style=for-the-badge)](https://greasyfork.org/en/scripts/580034-advanced-word-replacer)
[![Install from GitHub](https://img.shields.io/badge/Install%20Directly-GitHub-black.svg?style=for-the-badge)](https://github.com/Frist17/advanced-word-replacer/raw/main/advanced-word-replacer.user.js)
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

1. Sistem Penjaga Kesehatan UI & Watchdog Mandiri (UI Health Monitor & Watchdog)

Beberapa situs web novel memiliki skrip bawaan agresif yang sering menghapus elemen luar atau menyebabkan antarmuka pengguna (panel UI) macet. Skrip ini kini dilengkapi dengan monitor kesehatan berkala (setiap 2,5 detik) yang bekerja secara mandiri untuk:

    Mendeteksi jika panel terlepas dari halaman atau mendadak kosong, lalu memulihkannya kembali secara instan tanpa perlu menutup panel atau menyegarkan halaman.

    Menyediakan Function Watchdog yang otomatis mereset status penggantian jika mendeteksi adanya kemacetan sistem akibat proses manipulasi teks yang terlalu berat.

2. Pencocokan Lintas Elemen & Paragraf (Cross-Node & Cross-Block Replacement)

Teks terjemahan di halaman web sering kali terpecah oleh elemen format HTML (seperti teks tebal <b>, miring <i>, atau penanda glosari bawaan) [4]. Fitur baru ini mampu:

    Mendeteksi dan mengganti frasa secara utuh meskipun kata-kata tersebut terpisah oleh tag HTML inline yang berbeda [1, 2].

    Menghubungkan akhir baris paragraf pertama dengan awal baris paragraf berikutnya (lintas paragraf) untuk menangani kalimat yang terputus karena pergantian baris [1, 2].

    Melindungi penanda glosari bawaan situs agar teks di sekitarnya tetap terganti tanpa merusak fungsi tooltip atau klik asli dari situs tersebut.

3. Hash Scanner & Penggantian Berbasis Kemunculan (Positional Hash Overrides)

Fitur ini sangat berguna untuk situs web novel yang menggunakan sistem proteksi atau enkripsi nama karakter (seperti struktur span[data-hash] di wtr-lab atau WebNovel).

    Tab Hash Scanner: Menyediakan panel interaktif khusus untuk memindai seluruh kode hash unik di halaman, menampilkan statistik jumlah kemunculannya, mendeteksi konflik konteks, serta memberikan catatan kustom.

    Target Per-Kemunculan: Jika ada dua karakter berbeda yang kebetulan memiliki data-hash yang sama, Anda dapat memberikan nama pengganti yang berbeda berdasarkan urutan kemunculannya (misalnya, kemunculan ke-1 dinamai Tokoh A, sedangkan kemunculan ke-2 dinamai Tokoh B).

4. Mode Penggantian Teks Persis Bebas Regex (Exact-Text Replacements)

Menyusun ekspresi reguler (regex) untuk kalimat panjang yang penuh dengan tanda baca seperti koma, titik, atau tanda tanya terkadang cukup rumit.

    Cukup dengan menambahkan awalan exact: pada kolom input (misal: exact:Bab 1, Bagian 2), skrip akan mengabaikan mesin regex dan beralih ke pencocokan literal secara persis.

    Fitur ini juga secara otomatis merapikan spasi ganda atau karakter tak terlihat di antara kata agar proses pencocokan tetap berjalan dengan akurat.

5. Fitur Diagnosa Kata & Perbaikan ID Novel (Word Diagnosis & ID Auto-Fixer)

Jika Anda menemukan aturan kata yang tidak berfungsi sebagaimana mestinya, skrip ini menyediakan alat pelacak masalah yang transparan:

    Analisis Layer: Menampilkan rincian kecocokan aturan kata (mulai dari layer kecocokan judul novel, kesamaan URL, hingga deteksi domain aktif).

    ID Auto-Fixer: Jika diagnosa mendeteksi adanya ID novel yang usang atau tidak cocok karena perbedaan struktur situs, Anda dapat menekan tombol "Perbaiki Semua" untuk memetakan kembali aturan-aturan tersebut ke ID novel yang aktif saat ini secara otomatis.

6. Pencegah Loop & Teks Berkedip (Anti-Flicker Rate Limiter)

Pada situs web berbasis Single Page Application (SPA) yang memperbarui konten halaman secara dinamis menggunakan JavaScript, skrip pengganti teks rentan terjebak dalam lingkaran pemrosesan tanpa akhir (infinite mutation loops).

    Skrip ini menerapkan pembatas frekuensi mutasi pada tingkat elemen teks individual. Jika sebuah elemen terdeteksi mengalami perubahan berlebih dalam waktu singkat, skrip akan mengunci sementara proses penggantian pada elemen tersebut untuk menghemat konsumsi daya CPU dan mencegah teks berkedip (flickering).

7. Ekspor & Impor Aturan Parsial per Judul Novel

Selain fitur pencadangan cloud global, Anda kini dapat mengekspor aturan penggantian khusus untuk satu judul novel yang sedang Anda baca ke dalam berkas JSON lokal. Hal ini memudahkan Anda untuk membagikan daftar istilah atau nama karakter novel favorit Anda kepada pembaca lain tanpa harus membagikan seluruh isi kamus pribadi Anda.
8. Pembersihan Otomatis Recycle Bin & Vault Kredensial

    Auto-Clean: Anda dapat mengatur jangka waktu otomatis (seperti 7 hari, 30 hari, atau 90 hari) agar skrip menghapus kata-kata di keranjang sampah secara permanen guna menjaga performa database lokal tetap ringan.

    Credentials Vault: Anda dapat mengunduh berkas kredensial login (awr_credentials.js) secara lokal atau mencadangkannya di cloud untuk mempermudah proses pemulihan akun sinkronisasi Gist di perangkat lain tanpa perlu menyalin kode token secara manual.
---

## 📘 Panduan Penggunaan Detail (Usage Guide)

Berikut adalah panduan langkah demi langkah mengenai cara menggunakan alat
(tools) Advanced Word Replacer langsung dari antarmuka melayang (Floating UI)
yang muncul di halaman web Anda:

1. Persiapan Awal

  - Pastikan ekstensi Tampermonkey sudah terpasang di browser Anda dan skrip ini
    dalam kondisi aktif.
  - Saat Anda membuka salah satu situs web yang diizinkan (misalnya situs web
    novel populer seperti wtr-lab.com, webnovel.com, dll.), Anda akan melihat
    tombol melayang kecil bertuliskan "AWR Tools" di pojok kiri bawah layar
    Anda.
  - Klik tombol "AWR Tools" tersebut untuk membuka panel kontrol utama skrip.

2. Menambahkan Aturan Penggantian Kata (Tab Editor - Ikon Pena ✏️)

Tab ini digunakan untuk mendaftarkan kata-kata baru yang ingin Anda ubah
tampilannya pada teks novel:

1.  Kolom Teks Asli (Original Text): Masukkan kata yang salah diterjemahkan atau
    ingin diganti.
      - Variasi: Klik tombol + Variation untuk menggunakan pemisah garis tegak
        (|). Contoh: jika Anda mengisi Fugaku|fuguaku, maka kedua variasi
        penulisan tersebut akan diganti.
      - Wildcard: Klik + Wild Char untuk menyisipkan tanda bintang (*) untuk
        pencocokan karakter acak di tengah kata.
      - Exact: Klik + Exact untuk menyisipkan awalan exact:. Gunakan mode ini
        jika Anda ingin mengganti kalimat panjang yang mengandung banyak tanda
        baca secara harfiah tanpa memicu aturan pemrosesan regex biasa.
      - Hash: Klik + Hash Rule atau ketik awalan hash: secara manual untuk
        menargetkan elemen teks spesifik yang memiliki data enkripsi khusus
        (biasanya digunakan untuk situs web tertentu).
2.  Kolom Teks Pengganti (Replacement Text): Masukkan kata baru yang benar.
3.  Target Kategori (Target Category): Tentukan ruang lingkup berlakunya aturan
    kata tersebut:
      - Global Replacer (Semua Novel): Aturan kata akan aktif di seluruh situs
        web yang Anda buka.
      - Local Replacer (Hanya Novel Ini): Aturan kata hanya akan bekerja pada
        novel yang sedang aktif dibaca sekarang, sehingga tidak mengacaukan
        terminologi saat Anda membaca judul novel lain [2].
4.  Live Rule Sandbox: Di bagian bawah, Anda dapat mencoba mengetikkan teks
    sembarang untuk menguji apakah aturan kata Anda sudah bekerja dengan tepat
    sebelum mengeklik tombol Simpan.

  - Tip Cepat: Anda juga bisa menyorot teks yang salah di halaman web, lalu
    mengeklik tombol editor pada tooltip melayang yang muncul untuk mengisi
    kolom teks asli secara otomatis.

3. Mengelola Daftar Istilah (Tab Your Terms - Ikon Buku 📖)

Tab ini menampilkan semua daftar kata yang telah Anda simpan sebelumnya:

  - Fitur Pencarian: Gunakan kolom pencarian di bagian atas untuk menyaring kata
    lama atau kata baru dengan cepat.
  - Manajemen Grup Novel: Di setiap sub-judul novel, terdapat tombol ikon gerigi
    (⚙️) yang menyediakan menu untuk:
      - Mengaktifkan atau menonaktifkan grup novel tertentu secara eksklusif.
      - Mengubah nama grup novel tersebut.
      - Menggabungkan seluruh istilah dari grup tersebut ke grup lain atau
        menjadikannya global.
      - Memindahkan seluruh isi grup tersebut ke Recycle Bin.
  - Diagnosa Kata (🔍): Klik ikon kaca pembesar di samping kata apa saja untuk
    menganalisis secara mendalam mengapa kata tersebut aktif atau tidak aktif di
    halaman yang sedang Anda buka. Tombol "Perbaiki Semua" di dalam panel
    diagnosa juga dapat memetakan ulang ID novel yang usang secara otomatis.

4. Memindai Kata Terenkripsi (Tab Hash Scanner - Ikon Kaca Pembesar 🔍)

Tab ini dirancang khusus untuk menangani situs-situs terjemahan mesin yang
mengunci nama karakter menggunakan elemen span berkode unik (data-hash):

1.  Buka tab Hash Scanner saat Anda membaca di halaman novel. Skrip akan
    memindai dan menampilkan seluruh daftar kata unik yang terdeteksi di halaman
    tersebut.
2.  Anda dapat mencentang beberapa kata sekaligus untuk memberikan teks
    pengganti secara massal lewat kolom input bulk di bagian atas.
3.  Jika ada karakter dengan kode hash yang sama tetapi merujuk pada tokoh
    berbeda, klik tombol Per Kemunculan (⚙️) untuk menetapkan nama yang
    berbeda-beda berdasarkan urutan penulisan mereka di halaman tersebut.

  - Tip Alternatif: Anda juga dapat melakukan klik kanan pada kata unik yang
    ingin Anda ganti di dalam teks novel untuk membuka form pengisian aturan
    hash secara instan.

5. Keranjang Sampah (Tab Recycle Word - Ikon Daur Ulang ♻️)

Aturan kata yang Anda hapus tidak akan langsung hilang secara permanen,
melainkan dipindahkan terlebih dahulu ke tab ini:

  - Anda dapat memilih beberapa kata untuk dipulihkan (Undo) kembali ke kamus
    aktif Anda, atau menghapusnya secara permanen.
  - Jika Anda mengaktifkan pengaturan pembersihan otomatis di tab konfigurasi,
    sistem akan mengosongkan folder sampah ini sesuai dengan batas hari yang
    telah ditentukan.

6. Pengaturan & Sinkronisasi Cloud (Tab Settings - Ikon Gigi Roda ⚙️)

Tab ini dibagi menjadi beberapa sub-menu penting:

  - Situs Manajer (Filter): Mengatur apakah skrip berjalan menggunakan sistem
    Whitelist (hanya berjalan pada situs tertentu yang Anda daftarkan) atau
    Blacklist (berjalan di semua situs kecuali yang Anda daftarkan). Anda juga
    dapat mengeklik tombol preset untuk langsung mendaftarkan 20 situs novel
    populer secara otomatis.
  - Config (Pengaturan Skrip): Mengaktifkan/menonaktifkan sorotan warna biru
    tebal pada kata yang berhasil diganti, mengatur masa pembersihan otomatis
    Recycle Bin, serta memilih mode pembaruan skrip.
  - Data (Ekspor/Impor): Digunakan untuk mengunduh aturan kata khusus untuk satu
    novel aktif ke dalam file JSON di komputer Anda, atau mengimpor data istilah
    dari pembaca lain ke dalam novel Anda.
  - Cloud Manager (Cadangan Cloud):
    1.  Masukkan kode GitHub Token pribadi Anda (yang memiliki hak akses/izin
        Gist).
    2.  Klik Connect GitHub. Sistem akan otomatis mencari atau membuat berkas
        Private Gist baru di akun GitHub Anda secara aman dan gratis.
    3.  Setelah terhubung, klik Backup Now untuk mengunggah draf kamus Anda
        sebagai titik pemulihan.
    4.  Anda dapat melihat riwayat pencadangan berdasarkan tanggal di bagian
        bawah, serta memilih tombol Muat untuk mengembalikan cadangan lama atau
        Gabung untuk menyatukan data cadangan ke perangkat baru.


---

## 🛠️ Struktur Berkas Repositori

```
├── README.md                           # Dokumentasi Panduan Penggunaan ini
└── advanced-word-replacer.user.js      # Kode Sumber Utama Userscript

Lisensi (License)

Proyek ini dilisensikan di bawah MIT License. Anda bebas menggunakan, memodifikasi, dan menyebarkan skrip ini untuk kebutuhan pribadi atau komunitas.

dikembangkan dengan 💚 oleh @Frist17
