// Classic enchantment table, Item Maker costs and template enchantment points.
// GENERATED from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop):
//   Assets/Scripts/Game/MagicAndEffects/Effects/Enchanting/*.cs (classicSpellIDs, classicSpellCosts,
//   classicParamCosts, enchantCost, EnchantmentPayloadFlags) and Assets/Resources/ItemTemplates.txt
//   (enchantmentPoints). Numbers and parameter labels only; spell names come from the operator's
//   SPELLS.STD at run time. Regenerate with tools/alchemy-data.mjs if the reference changes.

/**
 * EnchantmentTypes value -> { key, flags, spell?, options }. Spell types list [spellsStdIndex, cost];
 * parameter types list [param, cost, label]; parameterless types list [-1, cost]. Negative costs are
 * side effects, which add enchantment capacity in the Item Maker.
 */
export const ENCHANTMENTS = Object.freeze({
  0: { key: 'CastWhenUsed', flags: ["Used"], spell: true, options: [[4, 330], [5, 250], [6, 540], [7, 480], [8, 380], [9, 480], [10, 1650], [18, 900], [11, 1560], [12, 1560], [13, 1560], [19, 1740], [14, 470], [15, 1020], [16, 990], [17, 1040], [22, 1980], [23, 1530], [24, 920], [20, 1420], [25, 840], [26, 1650], [33, 1020], [27, 1300], [28, 2290], [29, 1020], [34, 1610], [30, 1930], [31, 760], [35, 2140], [36, 3030], [32, 1750], [40, 130], [64, 360], [60, 930], [94, 480]] },
  1: { key: 'CastWhenHeld', flags: ["Equipped","MagicRound","RerollEffect"], spell: true, options: [[37, 240], [39, 1230], [41, 170], [10, 1650], [42, 170], [11, 1560], [12, 1560], [26, 1560], [13, 1560], [6, 540], [44, 210], [45, 150], [46, 1720], [24, 920], [47, 1720], [4, 330], [49, 1590], [82, 1020], [83, 1200], [84, 1200], [85, 1200], [86, 1200], [87, 1200], [88, 1200], [89, 1200]] },
  2: { key: 'CastWhenStrikes', flags: ["Strikes"], spell: true, options: [[50, 1620], [53, 780], [52, 1380], [54, 930], [56, 1830], [33, 1020], [20, 840], [25, 840], [16, 990], [7, 480], [55, 4230], [67, 1260]] },
  3: { key: 'ExtraSpellPts', flags: ["Held"], options: [[0, 500, "During Winter"], [1, 500, "During Spring"], [2, 500, "During Summer"], [3, 500, "During Fall"], [4, 200, "During Full Moon"], [5, 200, "During Half Moon"], [6, 200, "During New Moon"], [7, 700, "Near Undead"], [8, 800, "Near Daedra"], [9, 900, "Near Humanoids"], [10, 1000, "Near Animals"]] },
  4: { key: 'PotentVs', flags: ["Strikes"], options: [[0, 800, "Undead"], [1, 900, "Daedra"], [2, 1000, "Humanoid"], [3, 1200, "Animals"]] },
  5: { key: 'RegensHealth', flags: ["Held"], options: [[0, 4000, "all the time"], [1, 3000, "in sunlight"], [2, 3000, "in darkness"]] },
  6: { key: 'VampiricEffect', flags: ["Held","Strikes"], options: [[0, 2000, "at range"], [1, 1000, "when strikes"]] },
  7: { key: 'IncreasedWeightAllowance', flags: ["Held"], options: [[0, 400, "25% additional"], [1, 600, "50% additional"]] },
  8: { key: 'RepairsObjects', flags: ["Held"], options: [[-1, 900]] },
  9: { key: 'AbsorbsSpells', flags: ["Held"], options: [[-1, 1500]] },
  10: { key: 'EnhancesSkill', flags: ["Held"], options: [[-1, 900]] },
  11: { key: 'FeatherWeight', flags: ["Enchanted"], options: [[-1, 100]] },
  12: { key: 'StrengthensArmor', flags: ["Held"], options: [[-1, 700]] },
  13: { key: 'ImprovesTalents', flags: ["Held"], options: [[0, 500, "Hearing"], [1, 600, "Athleticism"], [2, 600, "Adrenaline Rush"]] },
  14: { key: 'GoodRepWith', flags: ["Held"], options: [[0, 1000, "Commoners"], [1, 1000, "Merchants"], [2, 1000, "Scholars"], [3, 1000, "Nobility"], [4, 1000, "Underworld"], [5, 5000, "All"]] },
  15: { key: 'SoulBound', flags: ["Enchanted","Breaks"], options: [[0, 0, "Rat"], [1, -10, "Imp"], [2, -20, "Spriggan"], [3, 0, "GiantBat"], [4, 0, "GrizzlyBear"], [5, 0, "SabertoothTiger"], [6, 0, "Spider"], [7, -10, "Orc"], [8, -30, "Centaur"], [9, -90, "Werewolf"], [10, -100, "Nymph"], [11, 0, "Slaughterfish"], [12, -10, "OrcSergeant"], [13, -30, "Harpy"], [14, -140, "Wereboar"], [15, 0, "SkeletalWarrior"], [16, -30, "Giant"], [17, 0, "Zombie"], [18, -300, "Ghost"], [19, -100, "Mummy"], [20, 0, "GiantScorpion"], [21, -30, "OrcShaman"], [22, -30, "Gargoyle"], [23, -300, "Wraith"], [24, -10, "OrcWarlord"], [25, -500, "FrostDaedra"], [26, -500, "FireDaedra"], [27, -100, "Daedroth"], [28, -700, "Vampire"], [29, -1500, "DaedraSeducer"], [30, -1000, "VampireAncient"], [31, -8000, "DaedraLord"], [32, -1000, "Lich"], [33, -2500, "AncientLich"], [34, 0, "Dragonling (no soul, general spawn)"], [35, -300, "FireAtronach"], [36, -300, "IronAtronach"], [37, -300, "FleshAtronach"], [38, -300, "IceAtronach"], [39, 0, "Horse_Invalid"], [40, -5000, "Dragonling_Alternate (has soul, quest spawn only)"], [41, -100, "Dreugh"], [42, -100, "Lamia"]] },
  16: { key: 'ItemDeteriorates', flags: ["Held"], options: [[0, -3000, "all the time"], [1, -1500, "in sunlight"], [2, -500, "in holy places"]] },
  17: { key: 'UserTakesDamage', flags: ["Held"], options: [[0, -6000, "in sunlight"], [1, -1000, "in holy places"]] },
  18: { key: 'VisionProblems', flags: [], options: [] }, // not offered by the classic Item Maker
  19: { key: 'WalkingProblems', flags: [], options: [] }, // not offered by the classic Item Maker
  20: { key: 'LowDamageVs', flags: ["Strikes"], options: [[0, -800, "Undead"], [1, -900, "Daedra"], [2, -1000, "Humanoid"], [3, -1200, "Animals"]] },
  21: { key: 'HealthLeech', flags: ["Held","Used","Strikes","Enchanted"], options: [[0, -4000, "Whenever used"], [1, -500, "Unless used daily"], [2, -200, "Unless used weekly"]] },
  22: { key: 'BadReactionsFrom', flags: ["Held"], options: [[0, -120, "Humanoids"], [1, -80, "Animals"], [2, -120, "Daedra"]] },
  23: { key: 'ExtraWeight', flags: ["Enchanted"], options: [[-1, -100]] },
  24: { key: 'WeakensArmor', flags: ["Held"], options: [[-1, -700]] },
  25: { key: 'BadRepWith', flags: ["Held"], options: [[0, -1000, "Commoners"], [1, -1000, "Merchants"], [2, -1000, "Scholars"], [3, -1000, "Nobility"], [4, -1000, "Underworld"], [5, -5000, "All"]] },
  26: { key: 'SpecialArtifactEffect', flags: [], options: [] }, // artifacts only, never offered
});

/** ItemTemplates enchantmentPoints by classic template index (0 = cannot be enchanted). */
export const ENCHANT_POINTS = Object.freeze({0:1750,1:2750,2:2250,3:3000,4:200,5:100,6:150,7:400,77:1000,82:20,83:30,84:30,85:20,86:400,87:600,88:700,89:700,90:1000,91:400,92:1500,93:1250,95:1300,96:1500,97:2000,98:4500,102:400,103:400,104:50,105:40,106:40,107:900,108:175,109:500,110:650,111:1000,112:1500,113:200,114:220,115:700,116:400,117:450,118:500,119:525,120:600,121:600,122:700,123:700,124:500,125:450,126:550,127:525,128:500,129:200,130:350,131:150,133:2300,134:1500,135:1800,136:1750,137:800,138:2050,139:600,140:1200,141:10,142:5,143:50,144:5,145:50,147:60,148:80,149:80,150:30,151:40,152:40,153:60,154:120,155:160,156:50,157:25,158:25,159:25,160:10,161:25,162:10,163:700,164:50,165:60,166:60,167:90,168:90,169:60,170:60,171:90,172:90,173:25,174:50,175:60,176:25,177:10,178:60,179:90,180:30,181:10,182:15,183:30,184:60,186:60,187:80,188:80,189:30,190:40,191:120,192:160,193:50,194:50,195:50,196:50,197:40,198:40,199:10,200:700,201:50,202:60,203:60,204:90,205:90,206:60,207:60,208:90,209:90,210:25,211:50,212:60,213:5,214:60,215:90,216:30,217:200,218:200,219:300,220:300,221:250,222:250,223:275,224:300,225:120,226:120,227:130,228:150,229:50,230:50,231:60,232:80,233:120,234:200,235:20,236:10,237:100,238:200,239:300,240:500,241:600,242:450,243:300,244:200,245:100,246:275,247:200,248:600,249:200,250:15,251:10,252:160,253:1000,254:75,255:75,256:100,257:200,274:3000});
