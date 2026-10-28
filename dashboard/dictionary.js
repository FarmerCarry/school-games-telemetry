/*
 * The research files' data dictionary (docs/RESEARCH_TELEMETRY_SPEC.md, §F.6): every file
 * of the research download with its columns in their pinned order, each as [name, type,
 * unit, values, meaning_en, meaning_ar, source, available_for]. The server's files
 * (students ... pcs) list exactly the COLUMNS of server/export.mjs, which
 * tools/tests/dashboard-research.test.mjs checks; games.csv and dictionary.csv are written
 * by the browser. It also holds the validity notes and writes the files the browser adds
 * to the download (dictionary.csv, games.csv, README.txt, labels.sps, load.R) and
 * docs/RESEARCH_DATA.md:
 *
 *   node server/dashboard/dictionary.js --md > docs/RESEARCH_DATA.md
 *
 * Pure: no DOM, no clock, no network. The page uses window.SGDictionary; Node loads it as
 * a plain script (module.exports when CommonJS is around).
 *
 * Types: code (random hex), text, category (one of the listed words), integer, decimal,
 * flag (1 yes, 0 no), date (YYYY-MM-DD), time (HH:MM:SS), datetime (YYYY-MM-DDTHH:MM:SSZ).
 * Days, weekdays and times are the school's clock; an empty cell is unknown or does not
 * apply. source names the wire field (docs/TELEMETRY.md) or "server" for a value the
 * server works out.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    if (typeof require === 'function' && require.main === module && process.argv.indexOf('--md') >= 0) process.stdout.write(api.markdown());
  }
  if (root) root.SGDictionary = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var ALL = 'all games', DDA = 'DDA games', SCORE = 'games with a score', TUTORIAL = 'tutorial games', FRAMES = 'games with frames';
  var BAND = '6-7, 8-9, 10-11; empty: not set', HEX = '12 hex digits', OLD = ' Empty for PCs on the old version.', OLD_AR = ' فارغ لأجهزة الإصدار القديم.';
  // A column: [name, type, unit, values, meaning_en, meaning_ar, source, available_for].
  function c(name, type, unit, values, en, ar, source, available) { return [name, type, unit || '', values || '', en, ar, source || 'server', available || ALL]; }
  // Columns several files share.
  var SESSION = c('session', 'code', '', HEX, 'The play session (sessions.csv).', 'جلسة اللعب (sessions.csv).', 'envelope.s');
  var STUDENT = c('student', 'code', '', HEX, 'The student code; empty for a guest and for PCs on the old version.', 'رمز الطالب؛ فارغ للضيف ولأجهزة الإصدار القديم.', 'envelope.u');
  var LINKED = c('student_linked', 'code', '', HEX,
    'The code this student counts under: the newer code an older one was linked to (by a teacher’s code transfer or on the dashboard), else the student code itself. Group a child’s rows by it. Empty for a guest.',
    'الرمز الذي يُحسب تحته هذا الطالب: الرمز الأحدث الذي رُبط به رمز أقدم (بنقل الرمز من صفحة المعلم أو من لوحة المتابعة)، وإلا فرمز الطالب نفسه. اجمع صفوف الطفل الواحد به. فارغ للضيف.', 'cd.oldCode, owner link');
  var PC = c('pc', 'code', '', HEX, 'The PC code: 12 random hex digits made once on each PC.' + OLD, 'رمز الجهاز: 12 خانة ست عشرية عشوائية تُنشأ مرة واحدة على كل جهاز.' + OLD_AR, 'envelope.p');
  var SESSION_BAND = c('band', 'category', '', BAND, 'The age group of the session: the profile’s, or the class default for a guest.', 'الفئة العمرية للجلسة: فئة الملف، أو الفئة الافتراضية للصف عند الضيف.', 'envelope.a');
  var WEEKDAY = c('weekday', 'integer', '', '1–7', 'The weekday of day: 1 Sunday … 7 Saturday.', 'يوم الأسبوع: 1 الأحد … 7 السبت.');
  var GAME = c('game', 'text', 'slug', '', 'The game, by its id in games.csv.', 'اللعبة بمعرّفها في games.csv.', 'go.slug');
  var count = function (name, en, ar, source, available) { return c(name, 'integer', '', '', en, ar, source, available); };
  var minutes = function (name, en, ar) { return c(name, 'decimal', 'min', '', en, ar, 'gx.engagedMs, gp.engagedMs'); };
  var WINS = count('wins', 'Rounds won.', 'الجولات التي فاز بها.', 're.code'), LOSSES = count('losses', 'Rounds lost.', 'الجولات التي خسرها.', 're.code');
  var DRAWS = count('draws', 'Rounds ended in a draw.', 'الجولات التي انتهت بالتعادل.', 're.code');
  var QUITS = count('quits', 'Rounds left unfinished.', 'الجولات التي تُركت دون إنهاء.', 're.code');
  var HITS = count('hits', 'Targets hit.', 'الأهداف التي أُصيبت.', 're.hits', DDA), MISSES = count('misses', 'Targets missed.', 'الأهداف التي أُخطئت.', 're.misses', DDA);
  var RT_MEAN = c('rt_mean_ms', 'integer', 'ms', '', 'The mean reaction time, exact (the sum of reaction times over their number).', 'متوسط زمن الاستجابة بدقة (مجموع أزمنة الاستجابة مقسومًا على عددها).', 're.x[4], re.x[5]', DDA);
  var share = function (name, en, ar, source, available) { return c(name, 'decimal', '', '0–1', en, ar, source, available); };
  var DEVICE = [
    c('cores', 'integer', '', '1, 2, 4, 8, 16', 'Processor cores, rounded down to one of these.', 'أنوية المعالج، مقرّبة إلى أقرب قيمة أدنى من هذه.', 'envelope.d[0]'),
    c('memory_gb', 'integer', 'GB', '0, 1, 2, 4, 8', 'Memory as the browser reports it, rounded down to one of these (0: not reported).', 'الذاكرة كما يذكرها المتصفح، مقرّبة إلى أقرب قيمة أدنى من هذه (0: لم تُذكر).', 'envelope.d[1]'),
    c('screen', 'integer', 'px', '1366, 1600, 1920, 2560', 'Screen width, rounded down to one of these.', 'عرض الشاشة، مقرّبًا إلى أقرب قيمة أدنى من هذه.', 'envelope.d[2]')
  ];
  var OUTCOMES = 'win, loss, draw, end, quit; empty: never ended';

  var FILES = [
    { file: 'students', from: 'server', one: ['student code with play in the period', 'رمز طالب لعب خلال الفترة'], columns: [
      c('student', 'code', '', HEX, 'The student code: 12 random hex digits made for one child’s profile on one PC. Nothing about the child goes into it.',
        'رمز الطالب: 12 خانة ست عشرية عشوائية تُنشأ لملف طفل واحد على جهاز واحد، ولا يدخل فيه شيء عن الطفل.', 'envelope.u'),
      c('student_label', 'text', '', '', 'The start of the code in capitals, as the dashboard shows it (Student 7F3A); longer when another code starts the same way.',
        'بداية الرمز بأحرف كبيرة، وهي ما تعرضه لوحة المتابعة بعد كلمة «الطالب»، وتطول إذا بدأ رمز آخر بالبداية نفسها.'),
      LINKED,
      c('kind', 'category', '', 'profile', 'Always profile: every student code belongs to a profile on a PC.', 'دائمًا profile: كل رمز طالب يخص ملفًا على جهاز.'),
      c('band_first', 'category', '', BAND, 'The age group of the code’s first session, as chosen when the profile was made. It does not move up a year, so use it as the cohort.',
        'الفئة العمرية في أول جلسة لهذا الرمز كما اختيرت عند إنشاء الملف. لا تتقدم مع مرور السنين، فاستخدمها لتحديد الفوج.', 'envelope.a'),
      c('band_last', 'category', '', BAND, 'The age group of the code’s latest session.', 'الفئة العمرية في أحدث جلسة لهذا الرمز.', 'envelope.a'),
      c('profile_made_day', 'date', '', '', 'The day the profile was made: the day of its first session here less the profile’s age then.',
        'يوم إنشاء الملف: يوم أول جلسة له هنا مطروحًا منه عمر الملف آنذاك.', 'ss.ageDays'),
      c('first_day', 'date', '', '', 'The day of the first play the server keeps for this code, in any period.', 'يوم أول لعب يحتفظ به الخادم لهذا الرمز، في أي فترة.'),
      c('last_day', 'date', '', '', 'The day of the latest play the server keeps for this code, in any period.', 'يوم آخر لعب يحتفظ به الخادم لهذا الرمز، في أي فترة.'),
      c('days_active', 'integer', 'days', '', 'Days with play in the exported period.', 'الأيام التي لعب فيها خلال الفترة المصدَّرة.'),
      count('sessions', 'Play sessions in the period.', 'جلسات اللعب خلال الفترة.', 'ss'),
      minutes('minutes', 'Engaged minutes in the period (see the note on engaged time).', 'دقائق اللعب الفعلي خلال الفترة (انظر الملاحظة عن وقت اللعب الفعلي).'),
      count('rounds', 'Rounds ended in the period.', 'الجولات المنتهية خلال الفترة.', 're'),
      WINS, LOSSES, QUITS,
      count('games_tried', 'Different games played in the period.', 'عدد الألعاب المختلفة التي لعبها خلال الفترة.', 'go.slug'),
      c('favourite_game', 'text', 'slug', '', 'The game with the most engaged minutes in the period (a tie goes to the first id in alphabetical order).',
        'اللعبة التي نالت أكثر دقائق اللعب الفعلي خلال الفترة (عند التساوي: أول معرّف أبجديًا).', 'go.slug, gx.engagedMs'),
      count('pcs', 'PCs this code has played on: one, or more when a teacher gave a profile on another PC the same code.',
        'عدد الأجهزة التي لُعب عليها بهذا الرمز: جهاز واحد، أو أكثر حين أعطى المعلم ملفًا على جهاز آخر الرمز نفسه.', 'envelope.p'),
      c('known_before', 'flag', '', '0, 1', '1 when the profile was made before the first play the server keeps for it: a child who played before the research data began.',
        '1 إذا أُنشئ الملف قبل أول لعب يحتفظ به الخادم له: طفل لعب قبل بدء بيانات البحث.', 'ss.ageDays'),
      c('removed_day', 'date', '', '', 'The day a PC removed this profile: the record stops there (censoring, not drop-out). Empty when it was not removed.',
        'اليوم الذي حُذف فيه هذا الملف من جهاز: يتوقف سجله عنده (انقطاع في الرصد لا انسحاب). فارغ إن لم يُحذف.', 'pr.code')
    ] },
    { file: 'sessions', from: 'server', one: ['play session', 'جلسة لعب'], columns: [
      c('session', 'code', '', HEX, 'The play session: a random id made when a child or a guest starts playing, and again at each change of player.',
        'جلسة اللعب: معرّف عشوائي يُنشأ حين يبدأ طفل أو ضيف اللعب، ويتجدد عند كل تغيير للاعب.', 'envelope.s'),
      STUDENT, LINKED, PC,
      c('kind', 'category', '', 'student, guest, unknown', 'student: a child with a profile; guest: played without picking an animal; unknown: a PC on the old version (wire 2), which does not tell students apart.',
        'student: طفل له ملف؛ guest: لعب دون اختيار حيوان؛ unknown: جهاز بالإصدار القديم (الإصدار 2) الذي لا يميّز الطلاب.', 'envelope.u, envelope.v'),
      c('wire_version', 'integer', '', '2, 3', 'The version of the data the PC sent: 3 since the update, 2 from PCs not updated yet.',
        'إصدار البيانات التي أرسلها الجهاز: 3 منذ التحديث، و2 من الأجهزة التي لم تُحدَّث بعد.', 'envelope.v'),
      SESSION_BAND,
      c('day', 'date', '', '', 'The school day the session started.', 'اليوم الدراسي الذي بدأت فيه الجلسة.', 'envelope.w'),
      WEEKDAY,
      c('start_time', 'time', '', '', 'The time the session started.', 'وقت بدء الجلسة.', 'envelope.w'),
      c('minute_of_day', 'integer', 'min', '0–1439', 'The start as minutes after midnight.', 'وقت البدء بالدقائق بعد منتصف الليل.', 'envelope.w'),
      c('start_utc', 'datetime', '', '', 'The start in world time (UTC): when the server received the play less the seconds the PC said had passed since the start.',
        'وقت البدء بالتوقيت العالمي (UTC): وقت استلام الخادم للعب مطروحًا منه الثواني التي ذكر الجهاز أنها مضت منذ البدء.', 'envelope.w'),
      c('clock_source', 'category', '', 'w, r', 'w: dated from the seconds the PC itself counted; r: estimated from the time the server received the play (PCs on the old version, or a count that did not add up).',
        'w: أُرّخت من الثواني التي عدّها الجهاز نفسه؛ r: قُدّرت من وقت استلام الخادم للعب (أجهزة الإصدار القديم، أو عدّ لم يستقم).', 'envelope.w'),
      c('mode', 'category', '', 'web, app', 'web: in a browser tab; app: the installed app.', 'web: في تبويب متصفح؛ app: التطبيق المثبّت.', 'envelope.m'),
      c('build', 'text', '', '', 'The version of the games site the PC ran (a build fingerprint).', 'إصدار موقع الألعاب على الجهاز (بصمة البناء).', 'envelope.k')
    ].concat(DEVICE, [
      c('classroom_mode', 'flag', '', '0, 1', '1 when the PC was in classroom mode.' + OLD, '1 إذا كان الجهاز في وضع الصف.' + OLD_AR, 'ss.cls'),
      count('profiles_on_pc', 'Profiles on the PC when the session started (at most 24).' + OLD, 'عدد الملفات على الجهاز عند بدء الجلسة (24 على الأكثر).' + OLD_AR, 'ss.np'),
      c('new_profile', 'flag', '', '0, 1', '1 when the profile was made in this session.', '1 إذا أُنشئ الملف في هذه الجلسة.', 'ss.isNew'),
      c('profile_age_days', 'integer', 'days', '', 'The profile’s age in days when the session started; empty for a guest.' + OLD,
        'عمر الملف بالأيام عند بدء الجلسة؛ فارغ للضيف.' + OLD_AR, 'ss.ageDays'),
      c('days_since_last', 'integer', 'days', '', 'Days since the profile last played; empty for a guest, a new profile or one that never played.' + OLD,
        'الأيام منذ آخر لعب للملف؛ فارغ للضيف وللملف الجديد أو الذي لم يلعب قط.' + OLD_AR, 'ss.sinceDays'),
      c('profile_age_bucket', 'integer', '', '0–3', 'The profile’s age as the old version sends it: 0 new or a guest, 1 1–6 days, 2 7–29 days, 3 30 days or more.',
        'عمر الملف كما يرسله الإصدار القديم: 0 جديد أو ضيف، 1 من يوم إلى 6 أيام، 2 من 7 إلى 29 يومًا، 3 ثلاثون يومًا فأكثر.', 'ss'),
      c('days_since_last_bucket', 'integer', '', '0–4', 'Days since the last play as the old version sends it: 0 the same day, 1 one day, 2 2–6 days, 3 7 days or more, 4 the first time.',
        'الأيام منذ آخر لعب كما يرسلها الإصدار القديم: 0 اليوم نفسه، 1 يوم واحد، 2 من يومين إلى 6 أيام، 3 سبعة أيام فأكثر، 4 أول مرة.', 'ss'),
      count('level_start', 'The profile’s level (from its experience points) when the session started; 0 for a guest.', 'مستوى الملف (من نقاط خبرته) عند بدء الجلسة؛ 0 للضيف.', 'ss.level'),
      count('level_ups', 'Times the profile went up a level in the session.', 'مرات ارتقاء الملف إلى مستوى أعلى في الجلسة.', 'lv'),
      count('games_opened', 'Games opened in the session.', 'الألعاب التي فُتحت في الجلسة.', 'go'),
      count('rounds', 'Rounds ended in the session.', 'الجولات المنتهية في الجلسة.', 're'),
      c('engaged_s', 'decimal', 's', '', 'Engaged seconds in the session’s games.', 'ثواني اللعب الفعلي في ألعاب الجلسة.', 'gx.engagedMs, gp.engagedMs'),
      c('end_t_s', 'integer', 's', '', 'Seconds from the start to the session’s end; empty when the end never arrived (the PC switched off or lost its connection for good).',
        'الثواني من البدء إلى نهاية الجلسة؛ فارغ إذا لم تصل النهاية (أُطفئ الجهاز أو انقطع اتصاله نهائيًا).', 'se.t'),
      c('end_reason', 'category', '', 'unload, switch, handover, idle', 'Why the session ended: unload, the page closed; switch, another player was picked; handover, the hand-over button; idle, 20 minutes without a touch.' + OLD,
        'سبب انتهاء الجلسة: unload أُغلقت الصفحة؛ switch اختير لاعب آخر؛ handover زر التسليم؛ idle عشرون دقيقة دون لمس.' + OLD_AR, 'se.why'),
      c('timer_minutes', 'integer', 'min', '', 'The minutes of the first classroom timer started in the session; empty without a timer.' + OLD,
        'دقائق أول مؤقت صفي بدأ في الجلسة؛ فارغ إن لم يُستخدم مؤقت.' + OLD_AR, 'ct'),
      c('timer_ended', 'flag', '', '0, 1', '1 when a classroom timer ran out in the session, 0 when one was started but did not run out; empty without a timer.',
        '1 إذا انتهى وقت مؤقت صفي في الجلسة، و0 إذا بدأ مؤقت ولم ينتهِ وقته؛ فارغ إن لم يُستخدم مؤقت.', 'ct')
    ]) },
    { file: 'visits', from: 'server', one: ['game visit (a game opened in a session)', 'زيارة لعبة (لعبة فُتحت في جلسة)'], columns: [
      SESSION,
      count('visit', 'The visit’s number in the session: 1 for the first game opened, and so on.', 'رقم الزيارة في الجلسة: 1 لأول لعبة فُتحت، وهكذا.', 'go.n'),
      STUDENT, LINKED, SESSION_BAND,
      c('day', 'date', '', '', 'The school day the game was opened (or closed, when the opening was not seen).', 'اليوم الدراسي الذي فُتحت فيه اللعبة (أو أُغلقت، إن لم يُرصد الفتح).', 'go.t'),
      c('open_time', 'time', '', '', 'The time the game was opened.', 'وقت فتح اللعبة.', 'go.t'),
      c('open_s', 'integer', 's', '', 'Seconds from the session’s start to the game’s opening.', 'الثواني من بدء الجلسة إلى فتح اللعبة.', 'go.t'),
      c('close_s', 'integer', 's', '', 'Seconds from the session’s start to the game’s close; empty when it never closed.', 'الثواني من بدء الجلسة إلى إغلاق اللعبة؛ فارغ إذا لم تُغلق.', 'gx.t'),
      c('open_seconds', 'integer', 's', '', 'Seconds the game was open (close_s − open_s).', 'الثواني التي بقيت فيها اللعبة مفتوحة (close_s − open_s).', 'go.t, gx.t'),
      c('engaged_s', 'decimal', 's', '', 'Engaged seconds: time with a key press or click in the last 20 seconds.', 'ثواني اللعب الفعلي: الوقت الذي سبقته ضغطة مفتاح أو نقرة خلال 20 ثانية.', 'gx.engagedMs, gp.engagedMs'),
      GAME,
      c('source', 'category', '', 'featured, catalog, recent, favorites, category, quick, search, related, surprise, reload, history, direct, starter',
        'Where the game was opened: the featured tile, the home page tiles, played recently, favourites, a category, quick picks, search, related games, surprise me, a page reload, back or forward, a direct link, the starter game.',
        'المكان الذي فُتحت منه اللعبة: البطاقة المميزة، أو بطاقات الصفحة الرئيسية، أو ما لُعب مؤخرًا، أو المفضلة، أو فئة، أو الاختيارات السريعة، أو البحث، أو الألعاب المشابهة، أو «فاجئني»، أو إعادة تحميل الصفحة، أو الرجوع والتقدم، أو رابط مباشر، أو لعبة البداية.', 'go.src'),
      count('plays_before', 'The child’s visits to this game before this one (0 for a guest).' + OLD, 'زيارات الطفل لهذه اللعبة قبل هذه الزيارة (0 للضيف).' + OLD_AR, 'go.playsBefore'),
      c('plays_before_bucket', 'integer', '', '0–4', 'plays_before as the old version sends it: 0, 1, 2 for 2–4, 3 for 5–9, 4 for 10 or more.',
        'plays_before كما يرسلها الإصدار القديم: 0، 1، 2 لما بين 2 و4، 3 لما بين 5 و9، 4 لعشرة فأكثر.', 'go'),
      c('favourite_at_open', 'flag', '', '0, 1', '1 when the child had given the game a heart before opening it.' + OLD, '1 إذا كان الطفل قد وضع قلبًا على اللعبة قبل فتحها.' + OLD_AR, 'go.fav'),
      c('load_ms', 'integer', 'ms', '', 'How long the game took to load.', 'مدة تحميل اللعبة.', 'ld.loadMs'),
      c('error', 'category', '', 'timeout, script, load', 'Why the game failed to start: it took too long, a script error, or a loading error; empty when it started.',
        'سبب تعذّر بدء اللعبة: استغرقت وقتًا طويلًا، أو خطأ في البرنامج، أو خطأ في التحميل؛ فارغ إذا بدأت.', 'er.kind'),
      count('rounds_started', 'Rounds started in the visit.', 'الجولات التي بدأت في الزيارة.', 'rs'),
      count('rounds_ended', 'Rounds ended in the visit.', 'الجولات التي انتهت في الزيارة.', 're'),
      c('tutorial', 'category', '', 'none, start, done', 'The game’s tutorial in this visit: none, started, or finished.', 'الدرس التعليمي للعبة في هذه الزيارة: none لم يظهر، start بدأ، done اكتمل.', 'tu.step', TUTORIAL),
      count('hearts_on', 'Times the heart (favourite) button was turned on in the visit.' + OLD, 'مرات تفعيل زر القلب (المفضلة) في الزيارة.' + OLD_AR, 'fv.on'),
      count('hearts_off', 'Times the heart button was turned off in the visit.' + OLD, 'مرات إلغاء القلب في الزيارة.' + OLD_AR, 'fv.on'),
      count('il_lt8', 'Key presses and clicks the game answered in under 8 ms.', 'ضغطات المفاتيح والنقرات التي استجابت لها اللعبة في أقل من 8 ملّي ثانية.', 'gx.il[0]'),
      count('il_lt16', '… in 8 to under 16 ms.', '… من 8 إلى أقل من 16 ملّي ثانية.', 'gx.il[1]'),
      count('il_lt33', '… in 16 to under 33 ms.', '… من 16 إلى أقل من 33 ملّي ثانية.', 'gx.il[2]'),
      count('il_lt50', '… in 33 to under 50 ms.', '… من 33 إلى أقل من 50 ملّي ثانية.', 'gx.il[3]'),
      count('il_lt100', '… in 50 to under 100 ms (a slow response).', '… من 50 إلى أقل من 100 ملّي ثانية (استجابة بطيئة).', 'gx.il[4]'),
      count('il_ge100', '… in 100 ms or more (a slow response).', '… في 100 ملّي ثانية فأكثر (استجابة بطيئة).', 'gx.il[5]'),
      count('frames_smooth', 'Picture updates drawn within 20 ms (smooth).', 'تحديثات الصورة التي رُسمت خلال 20 ملّي ثانية (سلسة).', 'gx.f[0]', FRAMES),
      count('frames_ok', 'Picture updates drawn in 20 to 34 ms.', 'تحديثات الصورة التي رُسمت في 20 إلى 34 ملّي ثانية.', 'gx.f[1]', FRAMES),
      count('frames_choppy', 'Picture updates drawn in 34 to 250 ms (choppy).', 'تحديثات الصورة التي رُسمت في 34 إلى 250 ملّي ثانية (متقطعة).', 'gx.f[2]', FRAMES),
      count('frames_stall', 'Picture updates that took over 250 ms (a freeze).', 'تحديثات الصورة التي استغرقت أكثر من 250 ملّي ثانية (توقف).', 'gx.f[3]', FRAMES),
      c('closed', 'flag', '', '0, 1', '1 when the game was closed in the usual way; 0 when the page closed first (its minutes still count).',
        '1 إذا أُغلقت اللعبة بالطريقة المعتادة؛ 0 إذا أُغلقت الصفحة قبلها (وتبقى دقائقها محسوبة).', 'gx'),
      c('previous_game', 'text', 'slug', '', 'The game opened just before in the session; empty for the first.', 'اللعبة التي فُتحت قبلها مباشرة في الجلسة؛ فارغ للأولى.', 'go.n'),
      c('next_game', 'text', 'slug', '', 'The game opened just after in the session; empty for the last.', 'اللعبة التي فُتحت بعدها مباشرة في الجلسة؛ فارغ للأخيرة.', 'go.n')
    ] },
    { file: 'rounds', from: 'server', one: ['round of a game', 'جولة في لعبة'], columns: [
      SESSION,
      count('visit', 'The visit in the session (visits.csv).', 'الزيارة في الجلسة (visits.csv).', 'rs.n, re.n'),
      count('round', 'The round’s number in the visit.', 'رقم الجولة في الزيارة.', 'rs.k, re.k'),
      STUDENT, LINKED, PC, SESSION_BAND,
      c('day', 'date', '', '', 'The school day the round started (or ended, when its start was not seen).', 'اليوم الدراسي الذي بدأت فيه الجولة (أو انتهت، إن لم يُرصد بدؤها).', 'rs.t, re.t'),
      WEEKDAY,
      c('time', 'time', '', '', 'The time the round started (or ended).', 'وقت بدء الجولة (أو انتهائها).', 'rs.t, re.t'),
      c('start_s', 'integer', 's', '', 'Seconds from the session’s start to the round’s start; empty when the start was not seen.', 'الثواني من بدء الجلسة إلى بدء الجولة؛ فارغ إذا لم يُرصد البدء.', 'rs.t'),
      c('minutes_into_session', 'decimal', 'min', '', 'Minutes from the session’s start to the round’s start (or end).', 'الدقائق من بدء الجلسة إلى بدء الجولة (أو انتهائها).', 'rs.t, re.t'),
      GAME,
      c('level', 'text', '', '', 'The round’s id in the game: its level or mode (for example L3 or endless).', 'معرّف الجولة في اللعبة: مرحلتها أو نمطها (مثل L3 أو endless).', 'rs.id, re.id'),
      c('outcome', 'category', '', OUTCOMES, 'How the round ended: win; loss; draw; end, a neutral end (endless runs, two-player modes); quit, left unfinished. Empty when it never ended.',
        'كيف انتهت الجولة: win فوز؛ loss خسارة؛ draw تعادل؛ end نهاية محايدة (الجولات المتواصلة وأنماط اللاعبَين)؛ quit تُركت دون إنهاء. فارغ إذا لم تنتهِ.', 're.code'),
      c('previous_outcome', 'category', '', OUTCOMES, 'The outcome of the round just before in the same visit; empty for the first.', 'نتيجة الجولة السابقة مباشرة في الزيارة نفسها؛ فارغ للأولى.', 're.code'),
      c('two_player', 'flag', '', '0, 1', '1 for a local two-player round (two children on one PC). These are left out of the skill measures.',
        '1 لجولة لاعبَين على جهاز واحد. تُستبعد هذه الجولات من مقاييس المهارة.', 're.id'),
      count('attempt', 'The student’s attempt at this game: the rounds of it the student has ended so far, this one included, in the order the server received them.',
        'محاولة الطالب في هذه اللعبة: جولاتها التي أنهاها الطالب حتى الآن ومعها هذه الجولة، بترتيب استلام الخادم لها.'),
      count('replay_in_session', 'Earlier starts of the same round id in this session.', 'مرات بدء معرّف الجولة نفسه قبلها في هذه الجلسة.', 'rs.replay'),
      c('engaged_ms', 'integer', 'ms', '', 'Engaged time in the round.', 'وقت اللعب الفعلي في الجولة.', 're.ms'),
      c('wall_ms', 'integer', 'ms', '', 'Clock time from the round’s start to its end (games built with the newer kit).', 'الوقت بالساعة من بدء الجولة إلى نهايتها (في الألعاب المبنية بالنسخة الأحدث).', 're.x[0]'),
      c('score', 'integer', '', '', 'The score the game passed; it means something different in each game (games.csv).', 'النتيجة التي مرّرتها اللعبة؛ يختلف معناها من لعبة إلى أخرى (games.csv).', 're.score', SCORE),
      c('tier_start', 'integer', '', '0–9', 'The difficulty tier at the start (0: the game has no tiers).', 'درجة الصعوبة عند البدء (0: لا درجات في اللعبة).', 'rs.tier', DDA),
      c('tier_end', 'integer', '', '0–9', 'The difficulty tier at the end (0: the game has no tiers).', 'درجة الصعوبة عند النهاية (0: لا درجات في اللعبة).', 're.tier', DDA),
      c('dda_level', 'integer', '‰', '0–1000', 'The difficulty level the game had chosen for this child, in thousandths (0 the easiest, 1000 the hardest); empty before the first adjustment.',
        'مستوى الصعوبة الذي اختارته اللعبة لهذا الطفل، بالألف (0 الأسهل، 1000 الأصعب)؛ فارغ قبل أول تعديل.', 're.x[6]', DDA),
      HITS, MISSES,
      share('accuracy', 'Accuracy: hits / (hits + misses); empty without either.', 'الدقة: hits / (hits + misses)؛ فارغة إذا لم يوجد أيّ منهما.', 're.hits, re.misses', DDA),
      count('rt_lt300', 'Reactions faster than 300 ms.', 'الاستجابات الأسرع من 300 ملّي ثانية.', 're.rt[0]', DDA),
      count('rt_lt500', 'Reactions in 300 to under 500 ms.', 'الاستجابات من 300 إلى أقل من 500 ملّي ثانية.', 're.rt[1]', DDA),
      count('rt_lt800', 'Reactions in 500 to under 800 ms.', 'الاستجابات من 500 إلى أقل من 800 ملّي ثانية.', 're.rt[2]', DDA),
      count('rt_lt1200', 'Reactions in 800 to under 1200 ms.', 'الاستجابات من 800 إلى أقل من 1200 ملّي ثانية.', 're.rt[3]', DDA),
      count('rt_lt2000', 'Reactions in 1200 to under 2000 ms.', 'الاستجابات من 1200 إلى أقل من 2000 ملّي ثانية.', 're.rt[4]', DDA),
      count('rt_ge2000', 'Reactions of 2000 ms or more.', 'الاستجابات في 2000 ملّي ثانية فأكثر.', 're.rt[5]', DDA),
      RT_MEAN,
      count('rt_n', 'Reactions measured.', 'عدد الاستجابات المقيسة.', 're.x[5]', DDA),
      count('inputs', 'Key presses and clicks in the round (games built with the newer kit).', 'ضغطات المفاتيح والنقرات في الجولة (في الألعاب المبنية بالنسخة الأحدث).', 're.x[1]'),
      c('inputs_per_min', 'decimal', '1/min', '', 'inputs per minute of wall_ms.', 'inputs لكل دقيقة من wall_ms.', 're.x[0], re.x[1]'),
      count('idle_lapses', 'Times the child came back after 20 seconds without a touch, inside the round.', 'مرات عودة الطفل بعد 20 ثانية دون لمس، داخل الجولة.', 're.x[2]'),
      count('pauses', 'Times the round was paused (the game paused, or the window lost the focus).', 'مرات توقف الجولة مؤقتًا (أوقفت اللعبة، أو فقدت النافذة التركيز).', 're.x[3]')
    ] },
    { file: 'events', from: 'server', one: ['event in a session', 'حدث في جلسة'], columns: [
      SESSION, STUDENT, LINKED,
      c('day', 'date', '', '', 'The school day of the event.', 'اليوم الدراسي للحدث.', 'lv.t, fv.t, tu.t, ct.t, pr.t, cd.t'),
      c('time', 'time', '', '', 'The time of the event.', 'وقت الحدث.', 'lv.t, fv.t, tu.t, ct.t, pr.t, cd.t'),
      c('t_s', 'integer', 's', '', 'Seconds from the session’s start to the event.', 'الثواني من بدء الجلسة إلى الحدث.', 'lv.t, fv.t, tu.t, ct.t, pr.t, cd.t'),
      c('kind', 'category', '', 'level_up, heart_on, heart_off, tutorial_start, tutorial_done, timer_start, timer_cancel, timer_end, profile_removed, linked',
        'What happened: the profile went up a level; the heart was turned on or off; a tutorial started or was finished; a classroom timer started, was cancelled or ran out; a profile was removed from the PC; an older code was linked to this session’s student.',
        'ما حدث: ارتقى الملف إلى مستوى أعلى؛ فُعّل القلب أو أُلغي؛ بدأ درس تعليمي أو اكتمل؛ بدأ مؤقت صفي أو أُلغي أو انتهى وقته؛ حُذف ملف من الجهاز؛ رُبط رمز أقدم بطالب هذه الجلسة.',
        'lv, fv, tu, ct, pr, cd'),
      c('game', 'text', 'slug', '', 'The game of the visit the event happened in; empty outside a game.', 'لعبة الزيارة التي وقع فيها الحدث؛ فارغ خارج الألعاب.', 'fv.n, tu.n'),
      c('value', 'text', '', '', 'level_up: the new level; timer_start: its minutes; profile_removed and linked: the code; else empty.',
        'level_up: المستوى الجديد؛ timer_start: دقائقه؛ profile_removed وlinked: الرمز؛ وإلا ففارغ.', 'lv.level, ct.minutes, pr.code, cd.oldCode')
    ] },
    { file: 'student_days', from: 'server', one: ['student code and school day with play', 'رمز طالب ويوم دراسي لعب فيه'], columns: [
      STUDENT, LINKED,
      c('day', 'date', '', '', 'The school day.', 'اليوم الدراسي.'),
      WEEKDAY,
      c('band', 'category', '', BAND, 'The age group of the day’s first session.', 'الفئة العمرية في أول جلسة من اليوم.', 'envelope.a'),
      count('sessions', 'Play sessions that day.', 'جلسات اللعب في ذلك اليوم.', 'ss'),
      minutes('minutes', 'Engaged minutes that day.', 'دقائق اللعب الفعلي في ذلك اليوم.'),
      count('opens', 'Games opened that day.', 'الألعاب التي فُتحت في ذلك اليوم.', 'go'),
      count('games', 'Different games played that day.', 'عدد الألعاب المختلفة التي لُعبت في ذلك اليوم.', 'go.slug'),
      count('rounds', 'Rounds ended that day.', 'الجولات المنتهية في ذلك اليوم.', 're'),
      WINS, LOSSES, DRAWS,
      count('ends', 'Rounds with a neutral end (endless runs, two-player modes).', 'الجولات ذات النهاية المحايدة (الجولات المتواصلة وأنماط اللاعبَين).', 're.code'),
      QUITS, HITS, MISSES, RT_MEAN,
      count('level_ups', 'Times the profile went up a level that day.', 'مرات ارتقاء الملف إلى مستوى أعلى في ذلك اليوم.', 'lv'),
      c('first_time', 'time', '', '', 'When the day’s first session started.', 'وقت بدء أول جلسة في اليوم.', 'envelope.w'),
      c('last_time', 'time', '', '', 'When the day’s latest session started.', 'وقت بدء آخر جلسة في اليوم.', 'envelope.w'),
      count('pcs', 'PCs played on that day.', 'الأجهزة التي لُعب عليها في ذلك اليوم.', 'envelope.p')
    ] },
    { file: 'daily_games', from: 'server', one: ['day, clock, age group and game', 'يوم وساعة وفئة عمرية ولعبة'], columns: [
      c('day', 'date', '', '', 'The day.', 'اليوم.'),
      c('clock', 'category', '', 'school, utc', 'school: a day on the school’s clock; utc: a day before the update, in world time (UTC) by when the server received the play, without students or hearts.',
        'school: يوم بحسب ساعة المدرسة؛ utc: يوم قبل التحديث بالتوقيت العالمي (UTC) بحسب وقت استلام الخادم للعب، دون الطلاب والقلوب.'),
      c('band', 'category', '', BAND, 'The age group of the sessions.', 'الفئة العمرية للجلسات.', 'envelope.a'),
      GAME,
      count('sessions', 'Play sessions that opened the game.', 'جلسات اللعب التي فُتحت فيها اللعبة.', 'go'),
      count('students', 'Different students who played it (each linked child once); empty on utc days.', 'عدد الطلاب المختلفين الذين لعبوها (كل طفل مرتبط مرة واحدة)؛ فارغ في أيام utc.', 'envelope.u'),
      count('opens', 'Times the game was opened.', 'مرات فتح اللعبة.', 'go'),
      minutes('minutes', 'Engaged minutes in the game.', 'دقائق اللعب الفعلي في اللعبة.'),
      count('starts', 'Rounds started.', 'الجولات التي بدأت.', 'rs'),
      count('ends', 'Rounds ended (every outcome).', 'الجولات التي انتهت (بأي نتيجة).', 're'),
      WINS, LOSSES, DRAWS,
      count('ends_neutral', 'Rounds with a neutral end (endless runs, two-player modes).', 'الجولات ذات النهاية المحايدة (الجولات المتواصلة وأنماط اللاعبَين).', 're.code'),
      QUITS,
      count('hearts_on', 'Hearts given in the game; empty on utc days.', 'القلوب التي مُنحت للعبة؛ فارغ في أيام utc.', 'fv.on'),
      count('hearts_off', 'Hearts taken back; empty on utc days.', 'القلوب التي أُلغيت؛ فارغ في أيام utc.', 'fv.on'),
      c('avg_tier', 'decimal', '', '1–9', 'The mean starting tier of the rounds that have one.', 'متوسط درجة الصعوبة عند البدء في الجولات التي لها درجة.', 'rs.tier', DDA),
      share('accuracy', 'Accuracy: hits / (hits + misses).', 'الدقة: hits / (hits + misses).', 're.hits, re.misses', DDA)
    ] },
    { file: 'pcs', from: 'server', one: ['PC code with play in the period', 'رمز جهاز لُعب عليه خلال الفترة'], columns: [
      c('pc', 'code', '', HEX, 'The PC code: 12 random hex digits made once on each PC. PCs on the old version send none and are not listed.', 'رمز الجهاز: 12 خانة ست عشرية عشوائية تُنشأ مرة واحدة على كل جهاز. أجهزة الإصدار القديم لا ترسله فلا تظهر هنا.', 'envelope.p'),
      c('pc_label', 'text', '', '', 'The first 4 characters of the code in capitals, as the dashboard and the teacher page show it.', 'أول 4 خانات من الرمز بأحرف كبيرة، كما تعرضه لوحة المتابعة وصفحة المعلم.'),
      c('first_day', 'date', '', '', 'The first day the server saw this PC, in any period.', 'أول يوم رأى فيه الخادم هذا الجهاز، في أي فترة.'),
      c('last_day', 'date', '', '', 'The latest day the server saw this PC, in any period.', 'آخر يوم رأى فيه الخادم هذا الجهاز، في أي فترة.'),
      c('days', 'integer', 'days', '', 'Days with play in the period.', 'الأيام التي لُعب فيها خلال الفترة.'),
      c('time_zone', 'text', '', '', 'The time zone the PC last reported (for example Asia/Riyadh).', 'المنطقة الزمنية التي ذكرها الجهاز آخر مرة (مثل Asia/Riyadh).', 'envelope.z'),
      c('build', 'text', '', '', 'The version of the games site the PC ran last.', 'إصدار موقع الألعاب الذي شغّله الجهاز آخر مرة.', 'envelope.k')
    ].concat(DEVICE, [
      count('sessions', 'Play sessions in the period.', 'جلسات اللعب خلال الفترة.', 'ss'),
      count('students', 'Different students who played on it (each linked child once).', 'عدد الطلاب المختلفين الذين لعبوا عليه (كل طفل مرتبط مرة واحدة).', 'envelope.u'),
      share('guest_share', 'Guest sessions / all sessions.', 'جلسات الضيوف / كل الجلسات.', 'envelope.u'),
      minutes('minutes', 'Engaged minutes in the period.', 'دقائق اللعب الفعلي خلال الفترة.'),
      share('smooth_share', 'Picture updates drawn within 20 ms / all picture updates.', 'تحديثات الصورة المرسومة خلال 20 ملّي ثانية / كل تحديثات الصورة.', 'gx.f', FRAMES),
      share('stall_share', 'Picture updates over 250 ms / all picture updates.', 'تحديثات الصورة التي تجاوزت 250 ملّي ثانية / كل تحديثات الصورة.', 'gx.f', FRAMES),
      c('avg_load_ms', 'integer', 'ms', '', 'The mean time a game took to load.', 'متوسط مدة تحميل اللعبة.', 'ld.loadMs'),
      share('slow_input_share', 'Key presses and clicks answered in 50 ms or more / all of them.', 'ضغطات المفاتيح والنقرات التي استُجيب لها في 50 ملّي ثانية فأكثر / كلها.', 'gx.il'),
      count('failures', 'Games that failed to start.', 'الألعاب التي تعذّر بدؤها.', 'er'),
      count('profiles_max', 'The most profiles the PC had at a session start (24 is full).', 'أكبر عدد من الملفات كان على الجهاز عند بدء جلسة (24 يعني امتلاءه).', 'ss.np'),
      count('new_profiles', 'Profiles made on the PC in the period.', 'الملفات التي أُنشئت على الجهاز خلال الفترة.', 'ss.isNew')
    ]) },
    { file: 'games', from: 'browser', one: ['game of the games site', 'لعبة من موقع الألعاب'], columns: [
      c('game', 'text', 'slug', '', 'The game’s id (the game column of the other files).', 'معرّف اللعبة (عمود game في الملفات الأخرى).', 'js/catalog.js'),
      c('name_ar', 'text', '', '', 'The game’s Arabic name on the site.', 'اسم اللعبة العربي على الموقع.', 'js/catalog.js'),
      c('name_en', 'text', '', '', 'The game’s English name.', 'اسم اللعبة الإنجليزي.', 'js/catalog.js'),
      c('categories', 'text', '', 'challenge, shooter, running, racing, two-player, sports, puzzle, strategy, arcade, idle, battle', 'The site’s categories of the game, separated by semicolons.',
        'فئات اللعبة على الموقع، تفصل بينها فواصل منقوطة.', 'js/catalog.js'),
      count('players', 'The most players at once.', 'أكبر عدد من اللاعبين في وقت واحد.', 'js/catalog.js'),
      c('input_style', 'category', '', 'pointer, keyboard, one-button, mixed', 'How the game is played: the mouse, the keyboard, one button, or mouse and keyboard.',
        'طريقة اللعب: الفأرة، أو لوحة المفاتيح، أو زر واحد، أو الفأرة ولوحة المفاتيح معًا.', 'js/catalog.js'),
      c('has_levels', 'flag', '', '0, 1', '1 when the period’s rounds of the game have two or more round ids (levels or modes); empty when nobody played it.',
        '1 إذا كان لجولات اللعبة خلال الفترة معرّفان أو أكثر (مراحل أو أنماط)؛ فارغ إذا لم يلعبها أحد.', 'rs.id'),
      c('dda', 'flag', '', '0, 1', '1 when the game adapts its difficulty to each child (tier and dda_level).', '1 إذا كانت اللعبة تكيّف صعوبتها لكل طفل (tier وdda_level).', 'games/ (Kit.dda)'),
      c('reports_hits', 'flag', '', '0, 1', '1 when the game counts hits and misses (accuracy).', '1 إذا كانت اللعبة تعدّ الإصابات والأخطاء (الدقة).', 'games/ (Kit.track)'),
      c('reports_reaction', 'flag', '', '0, 1', '1 when the game measures reaction times.', '1 إذا كانت اللعبة تقيس أزمنة الاستجابة.', 'games/ (Kit.track)'),
      c('reports_score', 'flag', '', '0, 1', '1 when the game passes a score.', '1 إذا كانت اللعبة تمرّر نتيجة.', 'Kit.stats.end'),
      c('score_meaning_en', 'text', '', '', 'What the score means in this game.', 'معنى النتيجة في هذه اللعبة، بالإنجليزية.', 'server/dashboard/scores.js'),
      c('score_meaning_ar', 'text', '', '', 'What the score means in this game, in Arabic.', 'معنى النتيجة في هذه اللعبة.', 'server/dashboard/scores.js'),
      c('tutorial', 'flag', '', '0, 1', '1 when the game shows a tutorial the first time.', '1 إذا كانت اللعبة تعرض درسًا تعليميًا في المرة الأولى.', 'games/ (Kit.stats.tutorial)')
    ] },
    { file: 'dictionary', from: 'browser', one: ['column of a file', 'عمود في ملف'], columns: [
      c('file', 'text', '', '', 'The file, without .csv.', 'الملف، دون .csv.'),
      c('column', 'text', '', '', 'The column, in the file’s order.', 'العمود، بترتيبه في الملف.'),
      c('type', 'category', '', 'code, text, category, integer, decimal, flag, date, time, datetime', 'The kind of value.', 'نوع القيمة.'),
      c('unit', 'text', '', '', 'The unit: s, ms, min, days, GB, px, ‰, slug (a game id) or 1/min.', 'الوحدة: s ثانية، ms ملّي ثانية، min دقيقة، days أيام، GB، px بكسل، ‰ بالألف، slug معرّف لعبة، 1/min لكل دقيقة.'),
      c('values', 'text', '', '', 'The values a category takes, or the range.', 'القيم التي تأخذها الفئة، أو المدى.'),
      c('meaning_en', 'text', '', '', 'What the column means, in English.', 'معنى العمود بالإنجليزية.'),
      c('meaning_ar', 'text', '', '', 'What the column means, in Arabic.', 'معنى العمود بالعربية.'),
      c('source', 'text', '', '', 'Where it comes from: the field the PC sends (event.field, docs/TELEMETRY.md), or server for a value the server works out.',
        'مصدره: الحقل الذي يرسله الجهاز (الحدث.الحقل، docs/TELEMETRY.md)، أو server لقيمة يحسبها الخادم.'),
      c('available_for', 'category', '', [ALL, DDA, SCORE, TUTORIAL, FRAMES].join(', '),
        'The games that fill it: all games, the games that adapt their difficulty (DDA games), the games with a score, the games with a tutorial, the games that report picture updates.',
        'الألعاب التي تملؤه: كل الألعاب، أو الألعاب التي تكيّف صعوبتها (DDA games)، أو الألعاب ذات النتيجة، أو الألعاب ذات الدرس التعليمي، أو الألعاب التي ترسل تحديثات الصورة.')
    ] }
  ];
  var BY_FILE = {};
  FILES.forEach(function (f) { BY_FILE[f.file] = f; });
  var SERVER_FILES = FILES.filter(function (f) { return f.from === 'server'; }).map(function (f) { return f.file; });
  function columns(file) { return BY_FILE[file] ? BY_FILE[file].columns.map(function (col) { return col[0]; }) : []; }
  // The header line of a file (its columns, comma-separated).
  function header(file) { return columns(file).join(','); }

  // The validity notes (§E): [English, Arabic]. They go in README.txt, docs/RESEARCH_DATA.md
  // and the dashboard's tooltips.
  var NOTES = [
    ['Engaged time counts key presses and clicks within 20-second windows, so watching without touching (waiting for a turn, a long animation) is undercounted.',
      'يعدّ وقت اللعب الفعلي ضغطات المفاتيح والنقرات ضمن نوافذ مدتها 20 ثانية، فيُحسب أقل من حقيقته وقتُ المشاهدة دون لمس (انتظار الدور، أو حركة طويلة على الشاشة).'],
    ['In the 3 games that adapt their difficulty, the win rate is held near 72% by design. Use the difficulty level and tier there as the measure of skill, not the win rate.',
      'في الألعاب الثلاث التي تكيّف صعوبتها تُبقى نسبة الفوز قرب 72% عن قصد. فاستخدم فيها مستوى الصعوبة ودرجتها مقياسًا للمهارة، لا نسبة الفوز.'],
    ['A score means something different in each game (games.csv). Compare scores within one game only.',
      'للنتيجة معنى مختلف في كل لعبة (games.csv)، فلا تقارن النتائج إلا داخل اللعبة الواحدة.'],
    ['Children choose their games, so comparisons between games are confounded by who chooses them.',
      'يختار الأطفال ألعابهم بأنفسهم، فالمقارنة بين الألعاب يشوبها اختلاف من يختار كل لعبة.'],
    ['The age group is picked when the profile is made and does not move up a year. Use band_first as the cohort.',
      'تُختار الفئة العمرية عند إنشاء الملف ولا تتقدم مع مرور السنين، فاستخدم band_first لتحديد الفوج.'],
    ['Two-player rounds (two children on one PC) are left out of the per-student skill measures.',
      'تُستبعد جولات اللاعبَين على جهاز واحد من مقاييس المهارة لكل طالب.'],
    ['Identity errors happen: a child playing on another child’s profile (a tab left open; the 20-minute idle hand-over reduces this), a profile deleted and made again, a child on two PCs whose codes were never linked, a PC that forgets its profiles every night. Guests are never attributed to a student.',
      'تقع أخطاء في الهوية: طفل يلعب على ملف طفل آخر (تبويب تُرك مفتوحًا، ويقلل التسليم بعد 20 دقيقة دون نشاط من ذلك)، أو ملف حُذف ثم أُنشئ من جديد، أو طفل على جهازين لم يُربط رمزاه، أو جهاز ينسى ملفاته كل ليلة. ولا يُنسب لعب الضيوف إلى أي طالب.'],
    ['Data is missing not at random: PCs where a teacher stopped the statistics, browsers that send Global Privacy Control, the offline copy of the site (which never sends), and PCs on the old version (student unknown).',
      'البيانات الناقصة ليست عشوائية: الأجهزة التي أوقف فيها المعلم الإحصاءات، والمتصفحات التي ترسل إشارة التحكم العام في الخصوصية، والنسخة غير المتصلة من الموقع (لا ترسل شيئًا)، وأجهزة الإصدار القديم (الطالب غير معروف).'],
    ['attempt is the order in which the server received a code’s rounds of a game; on one PC that is the order of play. Numbering starts again for a new code unless the codes were linked before that play. Re-rank by time in your analysis if needed.',
      'attempt هو ترتيب استلام الخادم لجولات رمز ما في لعبة ما، وهو على الجهاز الواحد ترتيب اللعب نفسه. ويبدأ العدّ من جديد لرمز جديد ما لم يُربط الرمزان قبل ذلك اللعب. أعد الترتيب حسب الوقت في تحليلك إن احتجت.'],
    ['Times are the session’s start (the server’s clock less the seconds the PC counted) plus the seconds into the session. Rows with clock_source r are estimated from the time the server received them.',
      'الأوقات هي بدء الجلسة (ساعة الخادم مطروحًا منها الثواني التي عدّها الجهاز) مضافًا إليه الثواني منذ بدء الجلسة. والصفوف التي clock_source فيها r مقدّرة من وقت استلام الخادم لها.'],
    ['Days before the update (clock utc in daily_games.csv) are world-time (UTC) days by when the server received the play, with totals only.',
      'الأيام التي سبقت التحديث (clock = utc في daily_games.csv) أيام بالتوقيت العالمي (UTC) بحسب وقت استلام الخادم للعب، وفيها المجاميع فقط.'],
    ['Use the paired comparisons for growth (the same children early and late); weekly averages mix new players with practised ones.',
      'استخدم المقارنات المزدوجة لقياس التحسن (الأطفال أنفسهم في البداية والنهاية)، فالمتوسطات الأسبوعية تخلط اللاعبين الجدد بالمتمرّسين.'],
    ['Small numbers (fewer than 5 children or 20 tries) carry a chip on the dashboard. Read them as early signs, not findings.',
      'تحمل الأرقام الصغيرة (أقل من 5 أطفال أو 20 محاولة) علامة في لوحة المتابعة، فاقرأها إشارات مبكرة لا نتائج.']
  ];

  // ---- CSV ------------------------------------------------------------------------------------
  // A cell of a file the browser writes: quoted when it holds a comma, a quote or a line break.
  function cell(v) {
    if (v === null || v === undefined) return '';
    var x = String(v);
    return /[",\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  }
  function csv(rows) { return rows.map(function (r) { return r.map(cell).join(','); }).join('\n') + '\n'; }
  // dictionary.csv: every column of every file.
  function dictionaryCsv() {
    var rows = [columns('dictionary')];
    FILES.forEach(function (f) { f.columns.forEach(function (col) { rows.push([f.file].concat(col)); }); });
    return csv(rows);
  }
  // games.csv. info: { games: { slug: [ar, en] }, about: SG_GAME_INFO, cats, scores: SG_SCORES,
  // levels: { slug: number of round ids in the period } }.
  function gamesCsv(info) {
    var names = info.games || {}, about = info.about || {}, scores = info.scores || {}, levels = info.levels || {};
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; };
    var rows = [columns('games')];
    Object.keys(names).sort().forEach(function (slug) {
      var a = own(about, slug) || {}, score = own(scores, slug), n = own(levels, slug);
      rows.push([slug, names[slug][0], names[slug][1], (a.cats || []).join(';'), a.players || '', a.input || '', n == null ? '' : n >= 2 ? 1 : 0,
        a.dda ? 1 : 0, a.track ? 1 : 0, a.track ? 1 : 0, score ? 1 : 0, score ? score[1] : '', score ? score[0] : '', a.tutorial ? 1 : 0]);
    });
    return csv(rows);
  }

  // ---- README.txt --------------------------------------------------------------------------------
  // "صف واحد", "صفّان", "5 صفوف", "11 صفًّا", "100 صف": an Arabic count of rows.
  function arRows(n) {
    var m = n % 100;
    if (n === 1) return 'صف واحد';
    if (n === 2) return 'صفّان';
    return n + (m >= 3 && m <= 10 ? ' صفوف' : m >= 11 ? ' صفًّا' : ' صف');
  }
  // info: { from, to, tz, exported (the school's time, 'YYYY-MM-DD HH:MM'), files: [{ name,
  // rows }], factsSince, legacyUntil, v3Since, part (1, 2, ...), stopped ({ file, rows }
  // when this part stops early), sample (the dashboard's sample data) }.
  function readme(info) {
    var i = info || {}, files = i.files || [];
    var rowsOf = function (f) { return f.rows === 1 ? '1 row' : String(f.rows) + ' rows'; };
    var oneOf = function (name) { var base = name.replace(/\.csv$/, '').replace(/-\d{4}-\d\d$/, ''); return BY_FILE[base] ? BY_FILE[base].one : null; };
    var en = [], ar = [];
    en.push('SCHOOL GAMES: RESEARCH FILES', '============================', '');
    en.push('Play on the school games site from ' + i.from + ' to ' + i.to + ', on the school’s clock (' + (i.tz || 'UTC') + '), exported ' + (i.exported || '') + '.');
    if (i.sample) en.push('These files are the dashboard’s SAMPLE DATA: made up to show the format. None of it comes from real children.');
    if (i.part > 1) {
      en.push('This is part ' + i.part + ' of the download: each file continues where part ' + (i.part - 1) + ' stopped. Add the parts’ rows together; no row is in two parts.',
        'The parts were made on different days: play that reached the server in between is in the later parts only, so they can hold visits, rounds and',
        'events of sessions that are in no sessions.csv, and children missing from students.csv. Keep the rows whose session is in sessions.csv, or download',
        'a period that ends yesterday or earlier in one go.');
    }
    if (i.stopped) en.push('This part stopped early, in ' + i.stopped.file + '.csv (today’s free reading allowance ran out). The next part continues from there;',
      'play that reaches the server before then will be in the next part only.');
    en.push('', 'FILES', '-----');
    files.forEach(function (f) { var one = oneOf(f.name); en.push(f.name + ': ' + rowsOf(f) + (one ? ', one per ' + one[0] : '')); });
    en.push('README.txt: this file. labels.sps: SPSS labels. load.R: an R loader.', '');
    en.push('IDENTIFIERS', '-----------',
      'No names are collected, and nothing a child types. Each profile (a child who picks an animal on a PC) has a student code: 12 random hex digits, the same for',
      'that profile in every file. student_label is the start of the code as the dashboard shows it ("Student 7F3A"). A child who plays on two PCs has two codes',
      'unless a teacher gave both profiles the same code on the teacher page, or the owner linked them on the dashboard; student_linked is the code a child counts',
      'under after those links, so group by student_linked. Guests (children who did not pick an animal) have an empty student and are counted in totals, never as',
      'students. Each PC has its own random code. Session codes are random too.', '');
    en.push('TIME', '----',
      'Days, weekdays (1 = Sunday … 7 = Saturday) and times are the school’s clock (' + (i.tz || 'UTC') + '). Each session’s start is the time the server received',
      'it less the seconds the PC counted since the start, so a PC with a wrong clock still dates its play right; start_utc is the same moment in world time.', '');
    var history = [];
    if (i.legacyUntil) history.push('Up to ' + i.legacyUntil + ': milestone 2. Daily totals only, on world-time (UTC) days by when the server received the play (daily_games.csv, clock utc).');
    if (i.factsSince) history.push('From ' + i.factsSince + ': play is kept row by row, on the school’s clock.');
    if (i.v3Since) history.push('From ' + i.v3Since + ': the first PC on the new version (wire 3): student and PC codes, exact ages and counts. PCs not updated yet send wire 2 (kind unknown).');
    if (history.length) { en.push('VERSION HISTORY', '---------------'); en.push.apply(en, history.concat([''])); }
    en.push('THINGS TO KNOW BEFORE ANALYSING', '-------------------------------');
    NOTES.forEach(function (n, k) { en.push((k + 1) + '. ' + n[0]); });
    en.push('', 'OPENING THE FILES', '-----------------',
      'The files are UTF-8 with a byte-order mark, comma-separated, with . as the decimal mark and an empty cell for a missing value.',
      'Excel: Data > From Text/CSV, File origin 65001: Unicode (UTF-8). rounds.csv is split by month (rounds-YYYY-MM.csv) when a period has more than 500,000 rounds,',
      'because Excel stops at 1,048,576 rows; use R or SPSS for the whole table.',
      'SPSS: run labels.sps from the folder of the files (it uses GET DATA /TYPE=TXT /ENCODING=\'UTF8\').',
      'R: source("load.R") in the folder of the files, or read.csv(f, fileEncoding = "UTF-8-BOM", na.strings = "").', '');
    en.push('EXAMPLE MODELS', '--------------',
      'Learning by practice, with each child, PC and game as random effects (R, lme4), on rounds.csv without two-player rounds:',
      '  r <- subset(rounds, two_player == 0 & outcome %in% c("win", "loss"))',
      '  r$win <- r$outcome == "win"',
      '  lme4::glmer(win ~ log(attempt) * band + (1 + log(attempt) | student_linked) + (1 | pc) + (1 | game), data = r, family = binomial)',
      'SPSS: GENLINMIXED with a binary target, or for a continuous measure (for example rt_mean_ms):',
      '  MIXED rt_mean_ms BY band WITH attempt /FIXED=band attempt band*attempt /RANDOM=INTERCEPT attempt | SUBJECT(student_linked).', '');
    en.push('CARE', '----',
      'These are pseudonymous records of individual children. Keep them like other school records, and check your rules on research with children before',
      'publishing. Parents should know the school keeps them.', '');

    ar.push('ألعاب الفسحة: ملفات البحث', '========================', '');
    ar.push('اللعب على موقع ألعاب المدرسة من ' + i.from + ' إلى ' + i.to + '، بحسب ساعة المدرسة (' + (i.tz || 'UTC') + ')، صُدّرت في ' + (i.exported || '') + '.');
    if (i.sample) ar.push('هذه الملفات هي البيانات التجريبية للوحة المتابعة: أُعدّت لعرض الشكل فقط، ولا شيء منها من أطفال حقيقيين.');
    if (i.part > 1) {
      ar.push('هذا هو الجزء ' + i.part + ' من التنزيل: يكمل كل ملف من حيث توقف الجزء ' + (i.part - 1) + '. اجمع صفوف الأجزاء معًا، فلا يتكرر صف في جزأين.',
        'صُنعت الأجزاء في أيام مختلفة: اللعب الذي وصل إلى الخادم بينها موجود في الأجزاء اللاحقة وحدها، فقد تحوي زيارات وجولات وأحداثًا لجلسات',
        'لا توجد في أي ملف sessions.csv، ويغيب أطفالها عن students.csv. أبقِ الصفوف التي توجد جلستها في sessions.csv، أو نزّل دفعة واحدة فترةً تنتهي أمس أو قبله.');
    }
    if (i.stopped) ar.push('توقف هذا الجزء مبكرًا في ' + i.stopped.file + '.csv (نفدت حصة القراءة المجانية لليوم)، ويكمل الجزء التالي من هناك؛',
      'واللعب الذي يصل إلى الخادم قبل ذلك سيكون في الجزء التالي وحده.');
    ar.push('', 'الملفات', '-------');
    files.forEach(function (f) { var one = oneOf(f.name); ar.push(f.name + ': ' + arRows(f.rows) + (one ? '، صف لكل ' + one[1] : '')); });
    ar.push('README.txt: هذا الملف. labels.sps: تسميات SPSS. load.R: برنامج تحميل للغة R.', '');
    ar.push('الرموز', '------',
      'لا تُجمع الأسماء ولا أي شيء يكتبه الطفل. لكل ملف (طفل يختار حيوانه على جهاز) رمز طالب من 12 خانة ست عشرية عشوائية، وهو نفسه لهذا الملف في كل الملفات.',
      'student_label بداية الرمز كما تعرضها لوحة المتابعة («الطالب 7F3A»). الطفل الذي يلعب على جهازين له رمزان، إلا إذا أعطى المعلم الملفين الرمز نفسه من صفحة المعلم',
      'أو ربطهما المسؤول في لوحة المتابعة؛ وstudent_linked هو الرمز الذي يُحسب تحته الطفل بعد هذا الربط، فاجمع الصفوف به. أما الضيوف (من لم يختر حيوانًا) فعمود',
      'student لهم فارغ، ويُحسبون في المجاميع ولا يُحسبون طلابًا أبدًا. ولكل جهاز رمزه العشوائي، ورموز الجلسات عشوائية كذلك.', '');
    ar.push('الوقت', '-----',
      'الأيام وأيام الأسبوع (1 الأحد … 7 السبت) والأوقات بحسب ساعة المدرسة (' + (i.tz || 'UTC') + '). بدء كل جلسة هو وقت استلام الخادم لها مطروحًا منه الثواني التي عدّها',
      'الجهاز منذ البدء، فيُؤرَّخ لعب الجهاز صحيحًا ولو كانت ساعته خاطئة؛ وstart_utc هو اللحظة نفسها بالتوقيت العالمي.', '');
    var historyAr = [];
    if (i.legacyUntil) historyAr.push('حتى ' + i.legacyUntil + ': المرحلة الثانية. مجاميع يومية فقط، بأيام التوقيت العالمي (UTC) حسب وقت استلام الخادم للعب (daily_games.csv، clock = utc).');
    if (i.factsSince) historyAr.push('من ' + i.factsSince + ': يُحفظ اللعب صفًّا صفًّا، بحسب ساعة المدرسة.');
    if (i.v3Since) historyAr.push('من ' + i.v3Since + ': أول جهاز بالإصدار الجديد (الإصدار 3): رموز الطلاب والأجهزة، والأعمار والأعداد الدقيقة. والأجهزة التي لم تُحدَّث بعد ترسل الإصدار 2 (kind = unknown).');
    if (historyAr.length) { ar.push('تاريخ الإصدارات', '---------------'); ar.push.apply(ar, historyAr.concat([''])); }
    ar.push('ما يجب معرفته قبل التحليل', '------------------------');
    NOTES.forEach(function (n, k) { ar.push((k + 1) + '. ' + n[1]); });
    ar.push('', 'فتح الملفات', '----------',
      'الملفات بترميز UTF-8 مع علامة ترتيب البايتات، تفصل بين قيمها فواصل، والنقطة هي الفاصلة العشرية، والخانة الفارغة قيمة ناقصة.',
      'Excel: البيانات > من نص/CSV، وأصل الملف 65001: Unicode (UTF-8). يُقسَّم rounds.csv حسب الشهر (rounds-YYYY-MM.csv) إذا زادت جولات الفترة على 500,000،',
      'لأن Excel يتوقف عند 1,048,576 صفًّا؛ فاستخدم R أو SPSS للجدول كاملًا.',
      'SPSS: شغّل labels.sps من مجلد الملفات (يستخدم GET DATA /TYPE=TXT /ENCODING=\'UTF8\').',
      'R: نفّذ source("load.R") في مجلد الملفات، أو read.csv(f, fileEncoding = "UTF-8-BOM", na.strings = "").', '');
    ar.push('نماذج للتحليل', '------------',
      'التعلّم بالممارسة، مع كل طفل وجهاز ولعبة أثرًا عشوائيًا (R، الحزمة lme4)، على rounds.csv دون جولات اللاعبَين: انظر المثال الإنجليزي أعلاه، فالشيفرة واحدة.', '');
    ar.push('العناية بالبيانات', '----------------',
      'هذه سجلات بأسماء مستعارة لأطفال أفراد. احفظها كما تحفظ سجلات المدرسة الأخرى، وراجع قواعد البحث مع الأطفال المعمول بها لديك قبل النشر.',
      'وينبغي أن يعلم أولياء الأمور أن المدرسة تحتفظ بها.', '');
    return en.join('\n') + '\n' + ar.join('\n');
  }

  // ---- SPSS and R --------------------------------------------------------------------------------
  var SPSS_FORMAT = { code: 'A12', text: 'A1000', category: 'A30', integer: 'F8.0', decimal: 'F12.4', flag: 'F1.0', date: 'SDATE10', time: 'TIME8', datetime: 'A20' };
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var quoteSps = function (s) { return "'" + String(s).replace(/'/g, "''") + "'"; };
  // A label SPSS keeps whole (at most 250 bytes): the meaning's first sentence, shortened.
  function spssLabel(text) {
    var first = String(text).split(/(?<=\.) /)[0];
    while (encodeUtf8Length(first) > 250) first = first.slice(0, -2) + '…';
    return first;
  }
  function encodeUtf8Length(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3; } return n; }
  // The words of a category column (values without the "empty: ..." note).
  function words(col) { return col[1] === 'category' ? col[3].split(';')[0].split(/,\s*/).filter(function (w) { return /^[a-z0-9_-]+$/.test(w); }) : []; }
  // labels.sps: for each file of the download, GET DATA with each column's format, the
  // variable labels and the value labels. names: the files' names (rounds may be by month).
  function spss(names) {
    var out = ['* SPSS syntax for the school games research files: run it from the folder that holds them.',
      '* Each block opens one file as a dataset with its labels. CD \'C:\\path\\to\\the\\folder\'. if SPSS starts elsewhere.', ''];
    (names || []).filter(function (n) { return /\.csv$/.test(n); }).forEach(function (name) {
      var base = name.replace(/\.csv$/, '').replace(/-\d{4}-\d\d$/, ''), f = BY_FILE[base];
      if (!f) return;
      var dataset = name.replace(/\.csv$/, '').replace(/-/g, '_');
      out.push('* ---- ' + name + ': one row per ' + f.one[0] + '.');
      out.push("GET DATA /TYPE=TXT /FILE='" + name + "' /ENCODING='UTF8' /ARRANGEMENT=DELIMITED /DELIMITERS=',' /QUALIFIER='\"' /FIRSTCASE=2");
      out.push('  /VARIABLES=' + f.columns.map(function (col) { return col[0] + ' ' + SPSS_FORMAT[col[1]]; }).join(' ') + '.');
      out.push('DATASET NAME ' + dataset + '.');
      out.push('VARIABLE LABELS ' + f.columns.map(function (col) { return col[0] + ' ' + quoteSps(spssLabel(col[4])); }).join('\n  /') + '.');
      var values = [];
      f.columns.forEach(function (col) {
        if (col[1] === 'flag') values.push(col[0] + " 0 'No' 1 'Yes'");
        else if (col[0] === 'weekday') values.push('weekday ' + WEEKDAYS.map(function (d, k) { return (k + 1) + " '" + d + "'"; }).join(' '));
        else if (words(col).length) values.push(col[0] + ' ' + words(col).map(function (w) { return quoteSps(w) + ' ' + quoteSps(w); }).join(' '));
      });
      if (values.length) out.push('VALUE LABELS ' + values.join('\n  /') + '.');
      out.push('EXECUTE.', '');
    });
    return out.join('\n') + '\n';
  }
  var R_CLASS = { code: 'character', text: 'character', category: 'character', integer: 'integer', decimal: 'numeric', flag: 'integer', date: 'Date', time: 'character', datetime: 'character' };
  var BAND_LEVELS = ['6-7', '8-9', '10-11'];
  // load.R: reads every file of the download with each column's class, the categories as
  // factors in their listed order and the age groups in age order ("" is not set: NA).
  function rLoader(names) {
    var out = ['# Loads the school games research files into R: run source("load.R") in the folder that holds them.',
      '# Missing values are empty cells; the files are UTF-8 with a byte-order mark.',
      'read_sg <- function(files, classes) {',
      '  parts <- lapply(files, function(f) read.csv(f, fileEncoding = "UTF-8-BOM", na.strings = "", colClasses = classes, stringsAsFactors = FALSE))',
      '  do.call(rbind, parts)',
      '}', ''];
    var have = (names || []).filter(function (n) { return /\.csv$/.test(n); });
    FILES.forEach(function (f) {
      var files = have.filter(function (n) { return n === f.file + '.csv' || (f.file === 'rounds' && /^rounds-\d{4}-\d\d\.csv$/.test(n)); });
      if (!files.length) return;
      var v = f.file;
      out.push('# ' + f.file + ': one row per ' + f.one[0] + '.');
      out.push(v + ' <- read_sg(c(' + files.map(function (n) { return '"' + n + '"'; }).join(', ') + '), c(' +
        f.columns.map(function (col) { return col[0] + ' = "' + R_CLASS[col[1]] + '"'; }).join(', ') + '))');
      f.columns.forEach(function (col) {
        if (/^band/.test(col[0]) && col[1] === 'category') out.push(v + '$' + col[0] + ' <- factor(' + v + '$' + col[0] + ', levels = c(' + BAND_LEVELS.map(function (b) { return '"' + b + '"'; }).join(', ') + '))');
        else if (col[0] === 'weekday') out.push(v + '$weekday <- factor(' + v + '$weekday, levels = 1:7, labels = c(' + WEEKDAYS.map(function (d) { return '"' + d + '"'; }).join(', ') + '))');
        else if (words(col).length > 1) out.push(v + '$' + col[0] + ' <- factor(' + v + '$' + col[0] + ', levels = c(' + words(col).map(function (w) { return '"' + w + '"'; }).join(', ') + '))');
      });
      out.push('');
    });
    return out.join('\n') + '\n';
  }

  // ---- docs/RESEARCH_DATA.md ---------------------------------------------------------------------
  var mdCell = function (s) { return String(s).replace(/\|/g, '\\|'); };
  function markdown() {
    var out = ['# Research data: the dictionary and how to read it', '',
      '<!-- Written by `node server/dashboard/dictionary.js --md > docs/RESEARCH_DATA.md` from server/dashboard/dictionary.js; do not edit by hand. -->', '',
      'The dashboard\'s **Data & settings** tab downloads the school\'s play as research files: `school-games-data_<from>_<to>.zip`, one CSV file per',
      'kind of row plus `games.csv`, `dictionary.csv` (this page as a table), `README.txt` (in English and Arabic), `labels.sps` (SPSS) and `load.R` (R).',
      'The server writes the rows (`GET /v1/admin/export`, `server/README.md`); the browser adds the headers, the byte-order mark and the other files.',
      'The design is in `docs/RESEARCH_TELEMETRY_SPEC.md` (§E, §F.6).', '',
      '## The files', '',
      '| File | One row per | Written by |', '|---|---|---|'];
    FILES.forEach(function (f) { out.push('| `' + f.file + '.csv` | ' + f.one[0] + ' | ' + (f.from === 'server' ? 'the server' : 'the browser') + ' |'); });
    out.push('', 'Every file is UTF-8 with a byte-order mark, comma-separated, with `.` as the decimal mark and an empty cell for a value that is',
      'unknown or does not apply (`-1` never appears). Days, weekdays (1 = Sunday … 7 = Saturday) and times are the school\'s clock. No value of the',
      'server\'s files needs quoting: each is a number, a date, a time or a validated token. `rounds.csv` becomes `rounds-YYYY-MM.csv` when the period',
      'has more than 500,000 rounds (Excel stops at 1,048,576 rows).', '',
      '## How the measures are made', '',
      '* **Students.** A student is a profile\'s random code (`student`); `student_linked` is the code a child counts under after a teacher\'s code',
      '  transfer or the owner\'s link, so a child on two PCs can be one student. Guests are counted in totals, never as students. There are no names.',
      '* **Engaged time** (`minutes`, `engaged_s`, `engaged_ms`) is time with a key press or click in the last 20 seconds; a visit that never closed',
      '  still counts its running time.',
      '* **Sessions** start when a child (or a guest) starts playing and end at the hand-over button, another player, 20 quiet minutes or the',
      '  page closing (`end_reason`). A whole session counts on the school day it started.',
      '* **Attempts** number a code\'s ended rounds of a game in the order the server received them (`attempt`); two-player rounds are left out of',
      '  skill measures (`two_player`).',
      '* **What came after a round** (the dashboard\'s persistence charts): the next round of the visit on the same level, another level, another',
      '  game later in the session, or nothing.',
      '* **Paired growth** compares the same children in the first and the last third of a period, each child weighing the same.',
      '* **Small samples** (fewer than 5 children or 20 tries) are shown with a "based on 2 children" chip, never hidden.', '',
      '## Things to know before analysing', '');
    NOTES.forEach(function (n, k) { out.push((k + 1) + '. ' + n[0], '   ' + n[1]); });
    out.push('', '## The columns', '',
      'Each file\'s columns in their order. *Available for*: ' + [ALL, DDA, SCORE, TUTORIAL, FRAMES].map(function (a) { return '`' + a + '`'; }).join(', ') +
      ' (the 3 adaptive games are bubble-bop, dino-3d and road-hopper). *Source* is the field the PC sends (`docs/TELEMETRY.md`), or *server*.', '');
    FILES.forEach(function (f) {
      out.push('### `' + f.file + '.csv`: one row per ' + f.one[0], '',
        '| Column | Type | Unit | Values | Meaning | المعنى | Source | Available for |', '|---|---|---|---|---|---|---|---|');
      f.columns.forEach(function (col) {
        out.push('| `' + col[0] + '` | ' + col[1] + ' | ' + mdCell(col[2]) + ' | ' + mdCell(col[3]) + ' | ' + mdCell(col[4]) + ' | ' + mdCell(col[5]) + ' | ' + mdCell(col[6]) + ' | ' + col[7] + ' |');
      });
      out.push('');
    });
    return out.join('\n').replace(/\n+$/, '\n');
  }

  return Object.freeze({
    FILES: FILES, SERVER_FILES: SERVER_FILES, NOTES: NOTES, AVAILABLE: [ALL, DDA, SCORE, TUTORIAL, FRAMES],
    file: function (name) { return BY_FILE[name] || null; }, columns: columns, header: header,
    cell: cell, csv: csv, dictionaryCsv: dictionaryCsv, gamesCsv: gamesCsv, readme: readme, spss: spss, rLoader: rLoader, markdown: markdown
  });
}));
