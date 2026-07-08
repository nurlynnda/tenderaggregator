export interface FieldCodeNode {
  code: string;
  name: string;
  children: FieldCodeNode[];
}

type RawLeaf = [code: string, name: string];
type RawSub = [code: string, name: string, leaves: RawLeaf[]];
type RawMain = [code: string, name: string, subs: RawSub[]];

function build(mains: RawMain[]): FieldCodeNode[] {
  return mains.map(([mCode, mName, subs]) => ({
    code: mCode,
    name: mName,
    children: subs.map(([sCode, sName, leaves]) => ({
      code: mCode + sCode,
      name: sName,
      children: leaves.map(([lCode, lName]) => ({
        code: mCode + sCode + lCode,
        name: lName,
        children: [],
      })),
    })),
  }));
}

const RAW: RawMain[] = [
  ['01', 'Penerbitan Dan Penyiaran', [
    ['01', 'Penerbitan', [
      ['01', 'Bahan Bacaan Terbitan Luar Negara'],
      ['02', 'Bahan Bacaan'],
      ['03', 'Penerbitan Elektronik Atas Talian'],
      ['04', 'Bahan Penerbitan Elektronik Dan Muzik/ Lagu (Siap Cetak)'],
    ]],
    ['02', 'Kertas', [
      ['01', 'Kertas'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Peralatan Penerbitan/ Percetakan', [
      ['01', 'Peralatan Percetakan Serta Aksesori'],
      ['02', 'Peralatan Sistem Bunyi, Pembesar Suara Dan Projektor'],
      ['03', 'Peralatan/ Perkakasan Penyuntingan/ Persembahan'],
      ['04', 'Medium Penyimpanan'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Papan Tanda Dan Aksesori', [
      ['01', 'Papan Tanda Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Fotografi Dan Filem', [
      ['01', 'Kamera Dan Aksesori'],
      ['02', 'Peralatan Pemprosesan Fotografi, Mikrofilem'],
      ['03', 'Filem Dan Mikrofilem'],
      ['04', 'Filem Siap Untuk Tayangan (Lesen B FINAS - Pengedar)'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Peralatan Pendidikan Dan Latihan', [
      ['01', 'Kit Pendidikan'],
      ['02', 'Bahan Pendidikan'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['02', 'Perabot, Peralatan Pejabat, Hiasan Dalaman Dan Domestik', [
    ['01', 'Perabot, Kelengkapan Dan Aksesori', [
      ['01', 'Perabot, Perabot Makmal Dan Kelengkapan Berasaskan Kayu/ Rotan/ Fabrik/ Logam/ Plastik (Workstation)'],
      ['02', 'Barangan Hiasan Dalaman Dan Aksesori'],
      ['03', 'Permaidani/ Ambar'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Mesin-mesin Pejabat Dan Aksesori', [
      ['01', 'Mesin-mesin Pejabat Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Perkakas Elektrik Dan Elektronik', [
      ['01', 'Perkakas Elektrik Dan Aksesori'],
      ['02', 'Perkakas Elektronik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Dan Perkakas Domestik', [
      ['01', 'Peralatan Dan Perkakas Domestik (Termasuk Barang-barang Yang Tidak Lekat Di Badan)'],
      ['02', 'Perkakasan Dan Bahan Kebersihan Diri Dan Mandian, Kelengkapan Bilik Air Dan Aksesori'],
      ['03', 'Bahan Pencuci Dan Pembersihan'],
      ['04', 'Solekan Dan Andaman'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Bahan Pembungkusan/ Bekas', [
      ['01', 'Bahan Pembungkusan/ Bekas/ Kotak/ Palet'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Bekalan Pejabat Dan Alatulis', [
      ['01', 'Alatulis (Tidak Termasuk Borang Dan Semua Jenis Kertas)'],
      ['02', 'Bahan Surih, Drafting Dan Alat Lukis'],
      ['03', 'Organiser, Dairi, Kalendar, Buku Alamat, Resit, Memo'],
      ['04', 'Tag/ Label/ Tanda Dan Stiker'],
      ['99', 'Pembuat'],
    ]],
    ['07', 'Tekstil', [
      ['01', 'Tekstil'],
      ['99', 'Pembuat'],
    ]],
    ['08', 'Pakaian Dan Kelengkapan', [
      ['01', 'Pakaian'],
      ['02', 'Kelengkapan Pakaian'],
      ['03', 'Bagasi Dan Beg Dari Kulit/ PVC/ Kanvas/ Kain/ Nylon/ Plastik/ Logam/ Dll'],
      ['04', 'Pakaian Keselamatan, Kelengkapan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['09', 'Bahan Tarpaulin Dan Kanvas', [
      ['01', 'Bahan Tarpaulin Dan Kanvas'],
      ['99', 'Pembuat'],
    ]],
    ['10', 'Aksesori Dan Bekalan Jahitan', [
      ['01', 'Butang Dan Bekalan Jahitan (Kits)'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['03', 'Sukan, Rekreasi Dan Alat Muzik (Peralatan, Bekalan Dan Aksesori Sukan Dan Rekreasi)', [
    ['01', 'Pakaian Sukan Dan Aksesori', [
      ['01', 'Pakaian Sukan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Cenderamata Dan Hadiah', [
      ['01', 'Cenderamata Dan Hadiah'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Alat Muzik', [
      ['01', 'Alat Muzik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Dan Aksesori Perkhemahan Dan Aktiviti Luar', [
      ['01', 'Peralatan Perkhemahan Dan Aktiviti Luar'],
      ['02', 'Peralatan Memancing'],
      ['03', 'Peralatan Memburu'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Peralatan Sukan Padang, Gelanggang, Rekreasi, Taman Permainan, Kecergasan Dan Sukan Air', [
      ['01', 'Peralatan Sukan'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['04', 'Makanan, Minuman Dan Bahan Mentah', [
    ['01', 'Makanan, Minuman Dan Bahan Mentah Kering/ Basah', [
      ['01', 'Makanan Dan Bahan Mentah Kering/ Basah'],
      ['02', 'Makanan Dan Minuman (Tin, Botol Dan Bungkus)'],
      ['03', 'Makanan Bermasak (Islam)'],
      ['04', 'Makanan Bermasak (Bukan Islam)'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['05', 'Peralatan Hospital, Perubatan, Ubat-ubatan Dan Farmaseutikal', [
    ['01', 'Peralatan Hospital, Bahan Dan Kelengkapan Perubatan', [
      ['01', 'Peralatan Dan Kelengkapan Hospital'],
      ['02', 'Peralatan Dan Kelengkapan Perubatan'],
      ['03', 'Peralatan Untuk Orang Kurang Upaya Dan Pemulihan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Ubat Dan Bahan Ubatan', [
      ['01', 'Dadah Berjadual [Perlu Lesen Di Bawah Peraturan-peraturan Kawalan Dadah Dan Kosmetik 1984 dari Kementerian Kesihatan Malaysia (KKM)]'],
      ['02', 'Racun Berjadual (Lesen Akta Racun 1952 dari Pengarah Kesihatan Negeri)'],
      ['03', 'Ubat Tidak Berjadual'],
      ['04', 'Makanan/ Minuman Tambahan (Food Suppliment)'],
      ['99', 'Pembuat [Perlu Lesen Pengilang (Borang 2) Dari KKM]'],
    ]],
    ['03', 'Pekakas, Tekstil dan Pakaian Perubatan Pakai Buang/ Guna Semula', [
      ['01', 'Pekakas Perubatan Pakai Buang'],
      ['02', 'Pakaian/ Tekstil Pakai Buang Kakitangan/ Pesakit'],
      ['03', 'Pakaian/ Tekstil Guna Semula Kakitangan/ Pesakit'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['06', 'Kimia, Bahan Kimia Dan Peralatan Makmal', [
    ['01', 'Kimia', [
      ['01', 'Kimia Makmal'],
      ['02', 'Kimia Industri'],
      ['03', 'Kimia Memproses Air'],
      ['04', 'Kimia Memproses Filem/ Fotografi'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Bahan Biokimia Dan Gas', [
      ['01', 'Bahan Peledak (Belerang, Pelarut Hidrokabon Dan Beroksigen/ Gunpowder)'],
      ['02', 'Bunga Api Dan Mercun'],
      ['03', 'Pencucuh/ Alat Penghasil Nyalaan'],
      ['04', 'Gas (Industri Dan Domestik)'],
      ['05', 'Pewarna/ Pencelup/ Lilin'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Bahan Bakar Dan Pelincir', [
      ['01', 'Bahan Bakar'],
      ['02', 'Bahan Pelincir'],
      ['03', 'Bahan Api Nuklear'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Cat, Anti Kakis Dan Bahan Tambah', [
      ['01', 'Cat'],
      ['02', 'Anti Kakis/ Bahan Tambah'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Peralatan Makmal', [
      ['01', 'Peralatan Makmal Serta Aksesori'],
      ['02', 'Peralatan Makmal Pengukuran, Pencerapan Dan Sukat'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['07', 'Pertanian, Perhutanan Dan Ternakan', [
    ['01', 'Baja Dan Racun', [
      ['01', 'Baja Dan Nutrien Tumbuhan (Organik/ Bukan Organik)'],
      ['02', 'Racun Serangga/ Perosak, Rumpai/ Tumbuhan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Tanaman, Ternakan, Baka Tanaman/ Ternakan Dan Sampel (Bahan Yang Telah Diawetkan)', [
      ['01', 'Tanaman/ Baka/ Benih Semaian'],
      ['02', 'Haiwan Ternakan/ Bukan Ternakan Dan Akuatik'],
      ['03', 'Sampel Dan Sampel Awetan Haiwan/ Akuatik/ Serangga/ Tumbuhan'],
    ]],
    ['03', 'Ubat, Makanan Ternakan/ Tumbuhan, Peralatan Dan Aksesori', [
      ['01', 'Ubat Haiwan/ Akuatik'],
      ['02', 'Makanan Haiwan/ Akuatik'],
      ['03', 'Peralatan Dan Kelengkapan Pertanian/ Ternakan/ Akuatik'],
      ['04', 'Hasil Sampingan Dan Sisa Perladangan'],
      ['05', 'Habitat Dan Tempat Kurungan Haiwan'],
      ['06', 'Peralatan Pengawalan Perosak Tanaman'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['08', 'Kejuruteraan Awam, Binaan Dan Kelengkapan Kemudahan Awam', [
    ['01', 'Kelengkapan/ Kemudahan Awam', [
      ['01', 'Kelengkapan/ Kemudahan Awam (Kecuali Kelengkapan Kemudahan Permainan/ Sukan)'],
      ['02', 'Kontena'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['09', 'Bahan Binaan Dan Peralatan Keselamatan Jalan Raya', [
    ['01', 'Bahan Binaan', [
      ['01', 'Bahan Binaan'],
      ['02', 'Paip Dan Kelengkapan'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Peralatan Keselamatan Jalan Raya', [
      ['01', 'Peralatan Keselamatan/ Perabot Jalan Raya'],
      ['99', 'Pembuat Keselamatan/ Perabot Jalan Raya'],
    ]],
  ]],
  ['10', 'Peralatan Sukatan Dan Ukuran', [
    ['01', 'Peralatan Sukatan Dan Ukuran', [
      ['01', 'Semua Peralatan Sukatan/ Ukuran'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['11', 'Pengangkutan, Komponen Dan Aksesori', [
    ['01', 'Kenderaan Bermotor Dan Tidak Bermotor', [
      ['01', 'Basikal'],
      ['02', 'Motosikal'],
      ['03', 'Kereta'],
      ['04', 'Lori'],
      ['05', 'Bas'],
      ['06', 'Kenderaan Kegunaan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Jentera Berat', [
      ['01', 'Jentera Berat'],
      ['02', 'Kren'],
      ['03', 'Trailer Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Alat Ganti Dan Aksesori Kenderaan/ Jentera Berat', [
      ['01', 'Alat Ganti/ Aksesori Kenderaan'],
      ['02', 'Alat Ganti/ Aksesori Jentera Berat'],
      ['03', 'Enjin Kenderaan/ Jentera Berat'],
      ['04', 'Peralatan Servis Dan Selenggara'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Kenderaan Ber Rel, Peralatan Dan Alat Ganti', [
      ['01', 'Kenderaan Ber Rel, Peralatan Dan Kereta Kabel'],
      ['02', 'Lokomotif Dan Troli Elektrik'],
      ['03', 'Sistem, Peralatan, Alat Ganti Keretapi Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Pesawat Udara, Kapal Terbang, Kapal Angkasa, Satelit, Radar', [
      ['01', 'Pesawat Udara'],
      ['02', 'Helikopter'],
      ['03', 'Alatganti Dan Kelengkapan Pesawat/ Helikopter'],
      ['04', 'Kapal Angkasa Dan Alatganti'],
      ['05', 'Satelit Dan Alatganti'],
      ['06', 'Radar Dan Alatganti'],
      ['07', 'Simulator'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Bot Dan Kapal', [
      ['01', 'Bot'],
      ['02', 'Kapal Laut/ Kapal Selam'],
      ['03', 'Alat Ganti Dan Kelengkapan Bot/ Kapal/ Kapal Selam'],
      ['04', 'Simulator Bot/ Kapal/ Kapal Selam'],
      ['99', 'Pembuat'],
    ]],
    ['07', 'Peralatan Marin', [
      ['01', 'Peralatan Marin'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['12', 'Pertahanan Dan Keselamatan', [
    ['01', 'Senjata, Peluru, Bahan Letupan Dan Aksesori', [
      ['01', 'Senjata Api'],
      ['02', 'Peluru Dan Bom'],
      ['03', 'Aksesori Senjata Api'],
      ['04', 'Bahan Letupan/ Complete Rounds'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Kelengkapan Sasaran', [
      ['01', 'Kelengkapan Sasaran'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Misil, Roket Dan Sub-Sistem', [
      ['01', 'Peluru Berpandu'],
      ['02', 'Sub Sistem Roket'],
      ['03', 'Pelancar Misil Dan Roket'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Keselamatan Dan Penguatkuasaan', [
      ['01', 'Alat Keselamatan, Perlindungan Dan Kawalan Perlindungan Dan Kawalan'],
      ['02', 'Alat Forensik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Pengesanan, Pemantauan Dan Perlindungan', [
      ['01', 'Kunci, Perkakasan Perlindungan Dan Aksesori'],
      ['02', 'Peralatan Pemantauan Dan Pengesanan'],
      ['03', 'Lesen/ Pengenalan Dan Pas Keselamatan Bersalut (Laminated)'],
      ['99', 'Pembuat'],
    ]],
    ['06', 'Perlindungan Kebakaran', [
      ['01', 'Sistem Pencegah Kebakaran'],
      ['02', 'Peralatan Kawalan Api'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['13', 'Peralatan Kejuruteraan Dan Mesin Pengeluaran', [
    ['01', 'Mesin, Kelengkapan Bengkel Dan Mesin Pengeluaran', [
      ['01', 'Mesin Dan Kelengkapan Bengkel'],
      ['02', 'Mesin Dan Kelengkapan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri', [
      ['01', 'Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Secondary)'],
      ['02', 'Mesin Dan Kelengkapan Khusus'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Sistem Kumbahan', [
      ['01', 'Peralatan Sistem Kumbahan Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Perindustrian Minyak', [
      ['01', 'Peralatan Perindustrian Huluan'],
      ['02', 'Peralatan Perindustrian Hiliran'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['14', 'Peralatan Kejuruteraan Elektrik Dan Elektronik', [
    ['01', 'Mesin Dan Jentera Penjanaan Dan Pengagihan Tenaga Elektrik Serta Aksesori', [
      ['01', 'Motor Dan Alat Ubah/ Alat Ganti'],
      ['02', 'Enjin, Komponen Enjin Dan Aksesori'],
      ['03', 'Komponen Enjin Pembakaran Dalaman/ Gas Turbine'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Stesen Janakuasa Elektrik Dan Peralatan Generator/ Alat Ganti Dan Bateri', [
      ['01', 'Stesen Janakuasa, Peralatan/ Alat Ganti/ Aksesori (Primary)'],
      ['02', 'Penjana Kuasa'],
      ['03', 'Alat Penyimpan Tenaga Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['03', 'Kabel, Wayar Elektrik Dan Aksesori', [
      ['01', 'Kabel Elektrik Dan Aksesori'],
      ['02', 'Wayar Elektrik Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
    ['04', 'Peralatan Untuk Tenaga Atom Dan Nuklear', [
      ['01', 'Reaktor Dan Instrumen Nuklear'],
      ['99', 'Pembuat'],
    ]],
    ['05', 'Sistem, Komponen Elektrik, Elektronik, Lampu Dan Aksesori', [
      ['01', 'Sistem Elektronik'],
      ['02', 'Komponen Dan Aksesori Elektrik/ Elektronik'],
      ['03', 'Lampu, Komponen Lampu Dan Aksesori'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['21', 'ICT (Information Communication Technology) (Bekalan Dan Perkhidmatan Bagi Sektor Teknologi Maklumat Dan Komunikasi)', [
    ['01', 'Peralatan Dan Kelengkapan Komputer, Perkakasan Dan Komponen', [
      ['01', 'Hardware (Low End Technology) — Supply All Types of Computer Hardware Including PC, Notebook, Printer, Document Scanner, Peripherals And Maintenance'],
      ['02', 'Hardware (High End Technology) — All Types of Server, Mainframe, High End Printers, Storage Area Network Software (SAN, NAS) Including Maintenance'],
      ['03', 'Software — Supply All Computers Software, Operating System, Database, Off-The-Shelf Packages Including Maintenance'],
      ['04', 'Software/ System Development/ Customization and Maintenance Including Data Entry, Data Processing'],
      ['05', 'Telecommunication/ Networking-supply Product, Infrastructure, Services Including Maintenance (LAN/ WAN/ Internet/ Wireless/ Satellite)'],
      ['06', 'Data Management — Provide Services Including Disaster'],
      ['07', 'ICT Security and Firewall, Encryption, PKI, Anti Virus'],
      ['08', 'Multimedia-Products, Services and Maintenance (Video Conferencing, Web Cast, Graphic Design, Animation)'],
      ['09', 'Hardware and Software Leasing/ Renting'],
      ['10', 'Geographic Information System (GIS) and Services'],
      ['11', 'Independent Verification and Validation (IV&V)'],
      ['99', 'Pembuat'],
    ]],
    ['02', 'Peralatan Dan Kelengkapan Telekomunikasi', [
      ['01', 'Alat Perhubungan'],
      ['02', 'Sistem Perhubungan/ Telekomunikasi'],
      ['03', 'Aksesori Penghubung Dan Telekomunikasi'],
      ['99', 'Pembuat'],
    ]],
  ]],
  ['22', 'Perkhidmatan', [
    ['01', 'Penyelenggaraan Dan Pembaikan Kenderaan', [
      ['01', 'Basikal (Tidak Perlu Lawatan Pengesahan)'],
      ['02', 'Motosikal'],
      ['03', 'Kenderaan Kegunaan Khusus (Seperti Kenderaan Rekreasi)'],
      ['04', 'Kenderaan Bawah 3 Ton'],
      ['05', 'Kenderaan Melebihi 3 Ton'],
      ['06', 'Jentera Berat (Lori Pelarik Tanah, Roller Dan Forklift)'],
      ['07', 'Kerja-Kerja Khusus (Baikpulih Enjin) Dan Sebagainya'],
      ['08', 'Kerja-Kerja Mengetuk dan Mengecat'],
      ['09', 'Alat Hawa Dingin Kenderaan'],
      ['10', 'Membaik Pulih Tempat Duduk/ Kusyen Dan Bumbung'],
      ['11', 'Kerja-Kerja Pembaikan Kenderaan Ber Rel Dan Kereta Kabel'],
      ['12', 'Kerja-Kerja Penyelenggaraan Sistem Kenderaan'],
      ['13', 'Membaik Pulih Tayar (Tidak Perlu Lawatan Pengesahan)'],
      ['14', 'Membaik Pulih Bateri (Tidak Perlu Lawatan Pengesahan)'],
      ['15', 'Kenderaan Pertahanan/ Keselamatan Negara – Motosikal'],
      ['16', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Kegunaan Khusus'],
      ['17', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Bawah 3 Ton'],
      ['18', 'Kenderaan Pertahanan/ Keselamatan Negara – Kenderaan Melebihi 3 Ton'],
      ['19', 'Kenderaan Pertahanan/ Keselamatan Negara – Jentera Berat'],
      ['20', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Khusus (Baikpulih Enjin) Dan Sebagainya'],
      ['21', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-kerja Mengetuk dan Mengecat'],
      ['22', 'Kenderaan Pertahanan/ Keselamatan Negara – Alat Hawa Dingin Kenderaan'],
      ['23', 'Kenderaan Pertahanan/ Keselamatan Negara – Membaik Pulih Tempat Duduk/ Kusyen dan Bumbung'],
      ['24', 'Kenderaan Pertahanan/ Keselamatan Negara – Kerja-Kerja Penyelenggaraan Sistem Kenderaan'],
    ]],
    ['02', 'Penyelenggaraan/ Pembaikan Mesin, Perabot Pejabat/ Kediaman', [
      ['01', 'Mesin-Mesin Pejabat/ Kediaman'],
      ['02', 'Perabot Pejabat/ Kediaman'],
      ['03', 'Alat Muzik, Kesenian Dan Aksesori'],
    ]],
    ['03', 'Penyelenggaraan/ Pembaikan Alat Hawa Dingin', [
      ['01', 'Alat Hawa Dingin (Window/ Split/ Berpusat)'],
    ]],
    ['04', 'Penyelenggaraan/ Pembaikan Alat Keselamatan', [
      ['01', 'Alat Kebombaan/ Alat Penyelamat/ Pemadam Api'],
      ['02', 'Peralatan Kawalan Keselamatan'],
      ['03', 'Mesin Pengimbas'],
    ]],
    ['05', 'Penyelenggaraan/ Pembaikan Kejuruteraan Dan Komunikasi', [
      ['01', 'Alat Semboyan/ Perhubungan/ Penyiaran'],
      ['02', 'Kontena/ Tangki'],
      ['03', 'Perkakas/ Sistem Elektrik'],
      ['04', 'Mesin dan Peralatan Woksyop'],
      ['05', 'Mechanisation System'],
      ['06', 'Membaiki Buff Fuel Tank'],
      ['07', 'Pump/ Paip Air Dan Komponen'],
      ['08', 'Baikpulih Barang-Barang Logam'],
      ['09', 'Production Testing, Surface Well Testing and Wire Line Services'],
      ['10', 'Faksimili'],
    ]],
    ['06', 'Penyelenggaraan/ Pembaikan Peralatan/ Kelengkapan Perubatan dan Makmal', [
      ['01', 'Alat Kelengkapan Perubatan/ Makmal'],
      ['02', 'Mesin Dan Peralatan Makmal'],
    ]],
    ['07', 'Penyelenggaraan/ Pembaikan Bot/ Kapal, Helikopter, Simulator Dan Pesawat', [
      ['01', 'Bot/ Kapal/ Barge/ Kapal Selam/ Jet Ski/ Sampan (Limbungan/ Tanpa Limbungan)'],
      ['02', 'Sand Blasting Dan Mengecat Untuk Kapal (Tidak Perlu Lawatan Pengesahan)'],
      ['03', 'Penyelenggaraan Kapal Terbang'],
      ['04', 'Penyelenggaraan Helikopter'],
      ['05', 'Penyelenggaraan Simulator Kapal'],
      ['06', 'Penyelenggaraan Simulator Kapal Terbang'],
      ['07', 'Penyelenggaraan Simulator Helikopter'],
      ['08', 'Pembaikan Kenderaan Yang Tidak Berenjin'],
      ['09', 'Kerja Pembaikan Kapal Angkasa/ Satelit'],
      ['10', 'Alat-Alat Marin (Tidak Termasuk Bot/ Kapal)'],
      ['11', 'Kenderaan Pertahanan/ Keselamatan Negara – Bot/ Kapal/ Barge/ Kapal Selam /Jet Ski (Limbungan/ Tanpa Limbungan)'],
      ['12', 'Kenderaan Pertahanan/ Keselamatan Negara – Sand Blasting Dan Mengecat Untuk Kapal'],
      ['13', 'Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Kapal Terbang'],
      ['14', 'Kenderaan Pertahanan/ Keselamatan Negara – Penyelenggaraan Helikopter'],
    ]],
    ['08', 'Pertahanan Dan Keselamatan', [
      ['01', 'Kawalan Keselamatan (Perlu lesen KDN)'],
      ['02', 'Penyiasat Persendirian (Perlu lesen KDN)'],
      ['03', 'Penyelenggaraan Dan Pembaikan Senjata'],
      ['04', 'Penyelenggaraan Misil/ Roket Dan Sub Sistem, Pelancar'],
    ]],
    ['09', 'Pengawalan Dan Pengawasan', [
      ['01', 'Kawalan Serangga Perosak, Anti Termite (Perlu Lesen Pengendali Kawalan Makhluk Perosak dari Jabatan Pertanian)'],
      ['02', 'Menangkap/ Menembak Haiwan'],
    ]],
    ['10', 'Khidmat Kebersihan Dan Rawatan', [
      ['01', 'Pembersihan Bangunan Dan Pejabat'],
      ['02', 'Membersih Kawasan'],
      ['03', 'Mengangkat Sampah'],
      ['04', 'Membersih Kenderaan (Perlu Lesen PBT)'],
      ['05', 'Mencuci Kolam Renang'],
      ['06', 'Membersih Pantai/ Sungai/ Terusan/ Empangan/ Tasik'],
      ['07', 'Pelupusan Dan Perawatan Sisa Berbahaya [Perlu Lesen daripada Lembaga Perlesenan Tenaga ATOM (AELB)]'],
      ['08', 'Pelupusan Dan Perawatan Buangan Terjadual (Perlu Lesen daripada Jabatan Alam Sekitar)'],
      ['09', 'Pelupusan dan Rawatan Sisa Radio Aktif dan Nuklear [Perlu Lesen daripada Lembaga Perlesenan Tenaga ATOM (AELB)]'],
      ['10', 'Kolam Kumbahan/ Sisa Perawatan/ Talian Paip/ Sesalur'],
      ['11', 'Pembersihan Tumpahan Minyak'],
    ]],
    ['11', 'Guna Tenaga', [
      ['01', 'Kakitangan Iktisas (Profesional) - Tidak Termasuk Khidmat Perundingan'],
      ['02', 'Kakitangan Separa Iktisas (Semi Profesional) - Tidak Termasuk Khidmat Perundingan'],
      ['03', 'Khidmat Guaman'],
      ['04', 'Tenaga Buruh'],
      ['05', 'Pemungut Hutang/ Penghantar Notis'],
      ['06', 'Stevedor'],
      ['07', 'Telly Clerk'],
      ['08', 'Mengikat Dan Melepas Tali Kapal (Mooring)'],
      ['09', 'Menyelam (Diving Service)'],
      ['10', 'Khidmat Latihan, Tenaga Pengajar dan Moderator/ Negotiator'],
      ['11', 'Salvage Boat/ Kapal'],
      ['12', 'Malim Kapal'],
    ]],
    ['12', 'Khidmat Udara/ Laut/ Darat', [
      ['01', 'Topografi/ LIDAR'],
      ['02', 'Pembajaan/ Pest Control'],
      ['03', 'Cloud Seeding'],
      ['04', 'Hidrografi'],
      ['05', 'Oceanografi'],
      ['06', 'Pemetaan/ Pemetaan Utiliti Bawah Tanah'],
      ['07', 'Geologi'],
    ]],
    ['13', 'Kesenian, Hiburan Dan Pelancongan', [
      ['01', 'Pengeluaran Filem (Perlu Lesen FINAS Borang A - Pengeluar)'],
      ['02', 'Rakaman'],
      ['03', 'Fotografi'],
      ['04', 'Audio Visual'],
      ['05', 'Penyediaan Pentas/ Pameran Pertunjukan, Taman Hiburan Dan Karnival/ Pestaria'],
      ['06', 'Artis Dan Penghibur Profesional'],
      ['07', 'Agen Pengembaraan (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['08', 'Dokumentasi Dan Panduarah'],
      ['09', 'Pemeliharaan Bahan Bahan Sejarah Dan Tempat Bersejarah'],
      ['10', 'Penyimpanan Rekod (Surat Kelulusan Daripada Arkib Negara)'],
      ['11', 'Membaikpulih Bahan Terbitan Dan Manuskrip (Surat Kelulusan Daripada Arkib Negara)'],
    ]],
    ['14', 'Pengindahan', [
      ['01', 'Bangunan/ Hiasan Dalaman (Tidak Termasuk Pelanskapan Dan Seni Taman)'],
      ['02', 'Hiasan Jalan/ Kawasan (Tidak Termasuk Pelanskapan Dan Seni Taman)'],
    ]],
    ['15', 'Penyewaan Dan Pengurusan', [
      ['01', 'Perabot/ Kelengkapan'],
      ['02', 'Mesin dan Peralatan Pejabat'],
      ['03', 'Kenderaan/ Jentera/ Kenderaan Rekreasi'],
      ['04', 'Kapal/ Bot/ Bot Tunda/ Feri/ Bot Malim/ Barge/ Jet Ski/ Kapal Selam'],
      ['05', 'Kapal Terbang/ Helikopter/ Pesawat/ Belon Panas/ Simulator Serta Lain-Lain Kenderaan Udara'],
      ['06', 'Bangunan/ Pejabat/ Stor/ Ruang Niaga/ Rumah Kediaman'],
      ['07', 'Kemudahan Awam/ Sukan'],
      ['08', 'Peralatan/ Kelengkapan Hospital Dan Makmal'],
      ['09', 'Peralatan Keselamatan dan Senjata'],
      ['10', 'Tempat Letak Kereta'],
      ['11', 'P.A Sistem Dan Alat Muzik'],
      ['12', 'Bantuan Kecemasan Dan Ambulans/ Kenderaan Jenazah'],
      ['13', 'Pakaian/ Kelengkapan Dan Aksesori'],
    ]],
    ['16', 'Percetakan', [
      ['01', 'Mencetak Buku, Majalah, Laporan Akhbar (Perlu Lesen KDN)'],
      ['02', 'Mencetak Fail, Kad Perniagaan Dan Kad Ucapan (Perlu Lesen KDN)'],
      ['03', 'Mencetak Label, Poster, Pelekat Dan Iron On (Perlu Lesen KDN)'],
      ['04', 'Mencetak Label, Poster Dan Pelekat (Plastik) (Perlu Lesen KDN)'],
      ['05', 'Mencetak Continuous Stationery Forms (Perlu Lesen KDN)'],
      ['06', 'Mencetak Borang/Kertas Komputer (Perlu Lesen KDN)'],
      ['07', 'Cetakan Keselamatan (Perlu Lesen KDN Dan Surat Kelulusan Pejabat Ketua Pengarah Keselamatan Kerajaan, Jabatan Perdana Menteri) (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['08', 'Cetakan Hologram (Perlu Lesen KDN Dan Surat Kelulusan Pejabat Ketua Pengarah Keselamatan Kerajaan, Jabatan Perdana Menteri) (Dikhaskan Kepada Syarikat 100% Bumiputera)'],
      ['09', 'Pisah Warna (Colour Separation)'],
      ['10', 'Menjilid Kulit Keras'],
      ['11', 'Varnishing'],
      ['12', 'Laminating'],
      ['13', 'Menjilid Kulit Lembut'],
      ['14', 'Pengatur Huruf (Type Setting)'],
      ['15', 'Rekabentuk Percetakan (Printing Design)'],
    ]],
    ['17', 'Perkhidmatan Pengangkutan, Penyimpanan Dan Pos', [
      ['01', 'Pemilik Kapal (Perlu Sijil MCR)'],
      ['02', 'Broker Perkapalan (Perjanjian Daripada Syarikat Perkapalan)'],
      ['03', 'Agen Perkapalan (Perlu Lesen Kastam)'],
      ['04', 'Pengangkutan Lori (Perlu Lesen APAD)'],
      ['05', 'Agen Penghantaran (Perlu Lesen Kastam)'],
      ['06', 'Pembungkusan Dan Penyimpanan (Perlu Gudang Berlesen Kastam Dan Lesen PBT)'],
      ['07', 'Pembungkusan'],
      ['08', 'Penghantaran Dokumen (Perlu Lesen Pos)'],
      ['09', 'Multimodal Transport Operator (MTO)'],
      ['10', 'Perkhidmatan Mel Pukal'],
      ['11', 'Pengurusan Pelabuhan'],
      ['12', 'Ship Chandling'],
      ['13', 'Ship Trimming'],
    ]],
    ['18', 'Perkhidmatan Kewangan Dan Insuran', [
      ['01', 'Syarikat Insuran (Perlu Lesen Bank Negara Malaysia)'],
      ['02', 'Broker Insuran (Perlu Lesen Bank Negara Malaysia)'],
      ['03', 'Penyediaan Akaun Dan Pengauditan'],
      ['04', 'Pengurusan Kewangan Dan Korporat'],
      ['05', 'Pemfaktoran (Dimansuhkan)'],
      ['06', 'Syarikat Pelelong Awam (Perlu Lesen Pelelong PBT)'],
    ]],
    ['19', 'Barang Lusuh', [
      ['01', 'Membeli Barang Lusuh Tanpa Permit'],
      ['02', 'Membeli Barang Lusuh Perlu Permit (Perlu Permit PDRM)'],
    ]],
    ['20', 'Editorial, Rakbentuk Grafik, Seni Halus Dan Harta Intelek', [
      ['01', 'Media Elektronik (Tidak Termasuk Kerja-kerja Percetakan)'],
      ['02', 'Media Cetak (Tidak Termasuk Kerja-kerja Percetakan)'],
      ['03', 'Bill Board'],
      ['04', 'Penulisan — Semua Jenis Penulisan'],
      ['05', 'Mereka-Cipta Dan Seni Halus'],
      ['06', 'Penterjemahan'],
      ['07', 'Pengkomersilan'],
      ['08', 'Hak Harta Intelek (Patent)'],
      ['09', 'Lain-lain Media Media Pengiklanan'],
      ['10', 'Perkhidmatan Fotostat'],
    ]],
    ['21', 'Perkhidmatan Perladangan/ Perikanan/ Haiwan Dan Hidupan Liar', [
      ['01', 'Perikanan Dan Akuakultur'],
      ['02', 'Hortikultur'],
      ['03', 'Ternakan'],
      ['04', 'Pertanian/ Tanaman/ Ladang/ Taman/ Hutan Dan Ladang Hutan'],
      ['05', 'Rawatan Hutan'],
      ['06', 'Sumber Air'],
      ['07', 'Tatahias Haiwan'],
      ['08', 'Tukun Tiruan'],
    ]],
    ['22', 'Perkhidmatan Hal Ehwal Sosial Dan Politik', [
      ['01', 'Hubungan Antarabangsa'],
      ['02', 'Bantuan Kemanusiaan'],
      ['03', 'Dasar Dan Peraturan'],
    ]],
    ['23', 'Perkhidmatan Domestik', [
      ['01', 'Solekan'],
      ['02', 'Dobi'],
      ['03', 'Membekal Air'],
      ['04', 'Pengurusan Jenazah Dan Kelengkapan'],
      ['05', 'Mengangkut Mayat'],
    ]],
    ['24', 'Perkhidmatan Menjahit Dan Baik Pulih', [
      ['01', 'Menjahit Pakaian Dan Kelengkapan'],
      ['02', 'Menjahit Bukan Pakaian'],
      ['03', 'Baik Pulih Kasut Dan Barangan Kulit'],
      ['04', 'Barangan PVC/ Kanvas'],
      ['05', 'Barangan Logam'],
    ]],
    ['25', 'Hotel, Rumah Tumpangan Dan Pusat Latihan', [
      ['01', 'Hotel/ Resort (Perlu Sijil Pendaftaran Premis Penginapan bawah Akta Industri Pelancongan 1992 MOTAC dan Lesen PBT)'],
      ['02', 'Motel/ Chalet/ Rumah Tumpangan (Perlu Lesen PBT)'],
      ['03', 'Homestay (Perlu Kementerian Surat Kementerian Pelancongan)'],
      ['04', 'Pusat Latihan (Perlu Lesen PBT)'],
    ]],
    ['26', 'Perkhidmatan Kejuruteraan Elektrik Dan Elektronik', [
      ['01', 'Akustik Dan Gelombang'],
      ['02', 'Pencahayaan (Illumination)'],
    ]],
    ['27', 'Perkhidmatan Lain-lain', [
      ['01', 'Pengurusan Telekomunikasi'],
      ['02', 'Marker/ DNA'],
      ['03', 'Bioteknologi'],
      ['04', 'Pensijilan Dan Pengiktirafan'],
      ['05', 'Ujian Makmal'],
      ['06', 'Kodifikasi'],
      ['07', 'Perkhidmatan Perubatan - Dialisis'],
    ]],
    ['28', 'Perkidmatan Teknologi Hijau', [
      ['01', 'Teknologi Hijau [Surat/ Sijil Daripada Suruhanjaya Tenaga (Energy Commission) atau Malaysia Green Technology Corporation]'],
    ]],
    ['29', 'Seni Ukir', [
      ['01', 'Ukiran Berasaskan Kayu [Perlu Kemukakan Sijil Pendaftaran Dengan Perbadanan Kemajuan Kraftangan Malaysia (PKKM)]'],
    ]],
  ]],
];

export const FIELD_CODE_TREE: FieldCodeNode[] = build(RAW);

export interface FlatFieldCode {
  code: string;
  name: string;
  path: string[];
}

export function flattenFieldCodes(tree: FieldCodeNode[] = FIELD_CODE_TREE): FlatFieldCode[] {
  const out: FlatFieldCode[] = [];
  const walk = (nodes: FieldCodeNode[], path: string[]) => {
    for (const node of nodes) {
      const nextPath = [...path, node.name];
      out.push({ code: node.code, name: node.name, path: nextPath });
      if (node.children.length > 0) walk(node.children, nextPath);
    }
  };
  walk(tree, []);
  return out;
}

export function fieldCodeMatchesPrefix(tenderCode: string, filterCode: string): boolean {
  return tenderCode.startsWith(filterCode);
}
