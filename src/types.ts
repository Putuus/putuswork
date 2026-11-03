/** 数据模型 —— 全站唯一的数据结构定义 */

/** 一条工时记录（同一天可以有多条，比如上午一个活、下午另一个活） */
export interface WorkRecord {
  id: string;
  /** YYYY-MM-DD（本地时区） */
  date: string;
  /** 工时，单位小时，支持小数（0.5） */
  hours: number;
  /** 单独覆盖时薪；null 表示用设置里的默认时薪 */
  rate: number | null;
  /** 备注 */
  note: string;
}

export interface Settings {
  /** 默认时薪（元/小时） */
  hourlyRate: number;
  /** 默认餐补金额，0 表示默认不给餐补 */
  defaultMeal: number;
  /** 是否显示收入数字（对应截图里那个眼睛） */
  showIncome: boolean;
  /** 一周从周几开始：0 = 周日，1 = 周一 */
  weekStart: 0 | 1;
  /** light / dark / auto（跟随系统） */
  theme: 'light' | 'dark' | 'auto';
  /** 货币符号 */
  currency: string;
  /** 左上角图标：public 目录下的文件名，'letter' 表示用文字「时」 */
  logo: string;
}

export interface AppData {
  version: number;
  settings: Settings;
  records: WorkRecord[];
  /** 餐补按天记：{ '2025-10-08': 20 }，金额范围 1~100 */
  meals: Record<string, number>;
}

export const MEAL_MIN = 1;
export const MEAL_MAX = 100;
export const DATA_VERSION = 1;

export function defaultSettings(): Settings {
  return {
    hourlyRate: 33.5,
    defaultMeal: 15,
    showIncome: true,
    weekStart: 0,
    theme: 'light',
    currency: '¥',
    logo: 'logo.png',
  };
}

export function emptyData(): AppData {
  return { version: DATA_VERSION, settings: defaultSettings(), records: [], meals: {} };
}
