/**
 * Arabic (Egypt).
 *
 * The keys are the English source strings; see i18n.tsx for why. Every entry
 * here is reachable from a `t()` call — `npm run check:i18n` fails the build if
 * one is not, because an orphaned entry almost always means the English copy
 * changed and this file silently stopped applying.
 *
 * Covered so far: the application shell, signing in, the web clock and the
 * password screens — the path a new advisor walks on their first morning, and
 * the controls they touch every shift. The supervisor and planning screens are
 * deliberately still English: the people who use them work in English, and a
 * half-translated planning screen is worse than an English one because the
 * reader cannot tell which half they are looking at.
 *
 * Register is plain Egyptian office Arabic. "سجّل حضور" is what somebody says
 * about clocking on; "تسجيل الحضور والانصراف" is what a manual says.
 */

export const ar: Record<string, string> = {
  // ------------------------------------------ shell and navigation
  'Dashboard': 'الرئيسية',
  'Time & Attendance': 'الحضور والانصراف',
  'Scheduling': 'الجداول',
  'My Shifts': 'ورديّاتي',
  'Admin': 'الإدارة',
  'Reports': 'التقارير',
  'Sign out': 'تسجيل الخروج',
  'Search': 'بحث',
  'Skip to content': 'تخطّي إلى المحتوى',
  'Open the guide': 'فتح الدليل',
  'Open the command palette': 'فتح لوحة الأوامر',
  'Sections': 'الأقسام',
  'Change your password': 'تغيير كلمة السر',
  'Language': 'اللغة',

  // ---------------------------------------------------- signing in
  'Email address': 'البريد الإلكتروني',
  'Password': 'كلمة السر',
  'Sign in': 'تسجيل الدخول',
  'Signing in…': 'جارٍ تسجيل الدخول…',

  // ----------------------------------------------------- the clock
  'Clock on': 'سجّل حضور',
  'Clock off': 'سجّل انصراف',
  'Change activity': 'غيّر النشاط',

  // ------------------------------------------- choosing a password
  'Choose your own password': 'اختر كلمة سر خاصة بك',
  'Current password': 'كلمة السر الحالية',
  'The password you were given': 'كلمة السر التي استلمتها',
  'New password': 'كلمة السر الجديدة',
  'New password again': 'أعد كتابة كلمة السر الجديدة',
  'Set my password': 'تعيين كلمة السر',
  'Saving…': 'جارٍ الحفظ…',
  'Cancel': 'إلغاء',
  'Those two do not match.': 'الكلمتان غير متطابقتين.',
  'Password changed.': 'تم تغيير كلمة السر.',
  'It takes effect now, everywhere you sign in.': 'يسري التغيير الآن على كل الأجهزة.',
  'You signed in with a password somebody issued to you. Choose one of your own before going any further — nothing else will work until you do.':
    'سجّلت الدخول بكلمة سر صادرة لك من الإدارة. اختر كلمة سر خاصة بك قبل المتابعة — لن يعمل أي شيء آخر قبل ذلك.',
  'At least 10 characters. A short phrase of a few words is stronger than a short word with symbols in it, and much easier to type on a shift. It must not contain your own name, email address or employee ID.':
    'عشرة أحرف على الأقل. جملة قصيرة من عدة كلمات أقوى من كلمة قصيرة بها رموز، وأسهل كثيرًا في الكتابة أثناء الوردية. ويجب ألّا تحتوي على اسمك أو بريدك الإلكتروني أو رقمك الوظيفي.',
  'Signed in as {email}. If that is not you, sign out and start again.':
    'مسجّل الدخول باسم {email}. إن لم يكن هذا حسابك، سجّل الخروج وابدأ من جديد.',

};
