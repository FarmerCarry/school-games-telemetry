// What the score means in each game that passes one to Kit.stats.end(result, score):
// [Arabic, English], each completing «النتيجة هنا هي …» / "The score here is …".
// Written by hand from the games' own code; a score is only comparable within one game.
// tools/tests/dashboard-research.test.mjs checks that these are exactly the 28 score games.
window.SG_SCORES = {
  'air-hockey': ['أهداف الطفل في المباراة', 'the child’s goals in the match'],
  'beat-dash': ['المسافة التي قطعها الطفل من المرحلة بالنسبة المئوية (100 عند إنهائها)', 'how far through the level the child got, in % (100 when it is finished)'],
  'blob-battle': ['أكبر حجم بلغه الهلام في الجولة', 'the biggest size the blob reached in the round'],
  'block-burst': ['نقاط الجولة', 'the points of the run'],
  'bubble-bop': ['نجوم المرحلة المنتهية (من 1 إلى 3)، وفي جولات الحفلة النقاط', 'the stars of a finished level (1 to 3); in the party rounds, the points'],
  'cake-guards': ['نجوم المرحلة الرابحة (من 1 إلى 3)، وإلا فعدد الموجات التي صُدّت', 'the stars of a won level (1 to 3); otherwise the waves held back'],
  'candy-rope': ['النجوم التي جُمعت في المرحلة المنتهية (من 0 إلى 3)', 'the stars collected in a finished level (0 to 3)'],
  'dino-3d': ['نقاط الجولة', 'the points of the run'],
  'drift-king': ['المسافة المقطوعة مع مكافأة الانزلاق', 'the distance driven plus the drift bonus'],
  'fire-and-ice': ['نجوم المرحلة المنتهية', 'the stars of a finished level'],
  'hoop-heads': ['نقاط الطفل في المباراة', 'the child’s points in the match'],
  'maze-dash': ['نجوم المرحلة المنتهية (من 0 إلى 3)، وفي التسلق المتواصل الارتفاع والنقاط', 'the stars of a finished level (0 to 3); in the endless climb, the height and the dots'],
  'merge-2048': ['نقاط اللعبة', 'the points of the game'],
  'moto-madness': ['نجوم المضمار المنتهي بحسب الوقت', 'the stars of a finished track, by time'],
  'neon-slope': ['مسافة الجولة', 'the distance of the run'],
  'paint-grab': ['أكبر نسبة لُوّنت من الأرض', 'the largest share of the ground painted, in %'],
  'pool-party': ['نجوم الضربة الخادعة الرابحة (محاولات أقل، نجوم أكثر)', 'the stars of a won trick shot (fewer tries, more stars)'],
  'rail-rush': ['المسافة المقطوعة بالأمتار', 'the distance run, in metres'],
  'road-hopper': ['المسافة التي قفزها الطفل', 'how far the child hopped'],
  'skybound-golf': ['مسافة الضربة', 'the distance of the shot'],
  'snake-arena': ['طول الثعبان عند نهاية الجولة', 'the snake’s length when the round ended'],
  'splat-strike': ['إصابات الطفل في المباراة', 'the child’s splats in the match'],
  'sumo-bonk': ['نقاط الطفل أمام الحاسوب', 'the child’s points against the computer'],
  'swing-hook': ['نجوم المرحلة المنتهية (من 0 إلى 3)، وفي اللعب المتواصل المسافة', 'the stars of a finished level (0 to 3); in the endless run, the distance'],
  'troll-level': ['نجوم المرحلة المنتهية', 'the stars of a finished level'],
  'tunnel-blitz': ['نقاط الجولة', 'the points of the run'],
  'typing-test': ['سرعة الكتابة بالكلمات في الدقيقة', 'the typing speed, in words per minute'],
  'wacky-soccer': ['أهداف الطفل في المباراة', 'the child’s goals in the match']
};
