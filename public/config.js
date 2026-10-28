// Supabase bağlantı bilgileri
// Supabase paneli → Project Settings → API (ya da "Connect") sayfasından kopyala.
// Bu iki değer herkese açık olabilir; güvenliği veritabanındaki kurallar sağlar.
// ASLA "service_role" / "secret" anahtarını buraya yazma.
window.YAYINDASIN_CONFIG = {
  SUPABASE_URL: '',      // örn. https://abcdefghijkl.supabase.co
  SUPABASE_ANON_KEY: ''  // "anon public" ya da "publishable" anahtar (sb_publishable_... veya eyJ... ile başlar)
};
