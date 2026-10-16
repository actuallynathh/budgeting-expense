import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  ListRenderItem,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset } from '@/constants/theme';

/* ------------------------------------------------------------------ *
 * Theme — bone white canvas, greens, earthy browns
 * ------------------------------------------------------------------ */
const COLORS = {
  /* Surfaces: a warm bone canvas so the pure-white cards read as raised. */
  background: '#F5F2EA',
  surface: '#FFFFFF',
  /** Inset wells: bar tracks, inputs, chips, segmented controls. */
  well: '#F0EBE0',
  border: '#E6DFD1',

  /* Greens */
  green: '#2E7D5B',
  greenDark: '#14523A',
  greenSoft: '#E4F1E9',
  greenEdge: '#BEDDCB',

  /* Earthy browns */
  brown: '#8B6A46',
  brownBright: '#B08652',
  brownSoft: '#F4EBDF',

  /* Ink */
  text: '#17251F',
  muted: '#6E7F77',

  /* Semantic */
  red: '#B2452C',

  /* Chrome */
  onColor: '#FFFFFF',
  shadow: '#14523A',
  scrim: 'rgba(20, 82, 58, 0.45)',
};

/* ------------------------------------------------------------------ *
 * Categories (exactly the 9 the app tracks)
 * ------------------------------------------------------------------ */
const CATEGORIES = [
  'Savings',
  'Food - Snacks',
  'Food - Real (Breakfast/Lunch/Dinner)',
  'Transportation',
  'Sports (e.g. Badminton)',
  'Treats (Gifts for others, etc.)',
  'Dog Care & Food',
  'Mandatory (Tithes, Cemetery, House needs)',
  'Other (Unexpected)',
] as const;

type Category = (typeof CATEGORIES)[number];

const CATEGORY_ICONS: Record<Category, string> = {
  'Savings': '🛡️',
  'Food - Snacks': '🍪',
  'Food - Real (Breakfast/Lunch/Dinner)': '🍽️',
  'Transportation': '🛵',
  'Sports (e.g. Badminton)': '🏸',
  'Treats (Gifts for others, etc.)': '🎁',
  'Dog Care & Food': '🐕',
  'Mandatory (Tithes, Cemetery, House needs)': '⛪',
  'Other (Unexpected)': '❓',
};

/* ------------------------------------------------------------------ *
 * Achievements
 * ------------------------------------------------------------------ */
const BADGE_SAVIOR = 'savior';
const BADGE_FRUGAL = 'frugal';

const BADGES = [
  {
    id: BADGE_SAVIOR,
    icon: '🛡️',
    name: 'Savior Badge',
    hint: 'Log any amount into the Savings category.',
  },
  {
    id: BADGE_FRUGAL,
    icon: '⚔️',
    name: 'Frugal Knight',
    hint: 'Keep the weekly average below a quarter of your Monthly Budget Goal (judged after a full week).',
  },
] as const;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */
type TransactionKind = 'expense' | 'income';

type Transaction = {
  id: string;
  title: string;
  amount: number;
  /** `null` for income, which is not categorised. */
  category: Category | null;
  kind: TransactionKind;
  /** Epoch millis so all month maths uses the phone local calendar. */
  date: number;
};

/** Budget Plan: target spend per category for the current month. */
type CategoryTargets = Partial<Record<Category, number>>;

type ReminderIds = {
  monthly: string | null;
  weekly: string | null;
  biweekly: string | null;
};

type PersistedState = {
  setupComplete: boolean;
  startingBalance: number;
  monthlyBudget: number;
  transactions: Transaction[];
  categoryTargets: CategoryTargets;
  unlockedBadges: string[];
  remindersEnabled: boolean;
  reminderIds: ReminderIds;
};

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
const STORAGE_KEY = '@budget-rpg/state/v1';

const XP_PER_LOG = 10;
const XP_PER_LEVEL = 50;

const DAYS_PER_WEEK = 7;

const NOTIFICATION_CHANNEL_ID = 'budget-reminders';
/** Reminders all fire at 09:00 device local time. */
const REMINDER_HOUR = 9;
/**
 * expo-notifications has no BIWEEKLY trigger type (only CALENDAR, DAILY, WEEKLY,
 * MONTHLY, YEARLY, DATE, TIME_INTERVAL), so the bi-weekly reminder repeats a
 * TIME_INTERVAL of exactly 14 days instead.
 */
const BIWEEKLY_SECONDS = 14 * 24 * 60 * 60;

const EMPTY_REMINDER_IDS: ReminderIds = { monthly: null, weekly: null, biweekly: null };

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const formatRupiah = (value: number) => `Rp ${Math.round(value).toLocaleString('id-ID')}`;

/** Digits only: "Rp 50.000", "50,000" and "50000" all parse to 50000. */
const parseAmount = (value: string) => {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length === 0 ? 0 : parseInt(digits, 10);
};

/** Local-calendar month key (YYYY-MM) — avoids the UTC drift of toISOString(). */
const localMonthKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const round = (value: number) => Math.round(value);

/* ------------------------------------------------------------------ *
 * Stats maths
 * ------------------------------------------------------------------ */
type MonthStats = {
  dayOfMonth: number;
  spentThisMonth: number;
  incomeThisMonth: number;
  savingsThisMonth: number;
  spentByCategory: CategoryTargets;
  /** Income minus expenses across the whole ledger (excludes the starting balance). */
  ledgerBalance: number;
  dailyAverage: number;
  weeklyAverage: number;
};

const getMonthStats = (transactions: Transaction[], now: Date): MonthStats => {
  const currentMonth = localMonthKey(now);
  const dayOfMonth = now.getDate();

  let spentThisMonth = 0;
  let incomeThisMonth = 0;
  let savingsThisMonth = 0;
  let ledgerBalance = 0;
  const spentByCategory: CategoryTargets = {};

  for (const item of transactions) {
    const isIncome = item.kind === 'income';
    ledgerBalance += isIncome ? item.amount : -item.amount;

    // Everything below is scoped to the current month, which is what makes the
    // HP bar, averages and plan tracker reset on the 1st automatically.
    if (localMonthKey(new Date(item.date)) !== currentMonth) continue;

    if (isIncome) {
      incomeThisMonth += item.amount;
      continue;
    }

    spentThisMonth += item.amount;
    // Savings is an expense category (money leaves the wallet) but it also feeds
    // the Mana bar, so it is tracked twice on purpose.
    if (item.category === 'Savings') savingsThisMonth += item.amount;
    if (item.category) {
      spentByCategory[item.category] = (spentByCategory[item.category] ?? 0) + item.amount;
    }
  }

  // DAILY AVERAGE MATH
  // "Days passed" is the calendar day number (the 1st = 1, the 15th = 15), never
  // 0, so this can not divide by zero. We do not subtract partial days: a monthly
  // budget is paced daily, so by the 15th the user should have spent 15 days worth.
  //   daily = spent this month / days passed
  const dailyAverage = spentThisMonth / dayOfMonth;

  // WEEKLY AVERAGE MATH
  // "Weeks passed" = days passed / 7, kept fractional (and always >= 1/7) so the
  // rate stays honest on the first days of the month: on day 3 the divisor is
  // 0.43 weeks, so Rp 30.000 spent extrapolates to a Rp 70.000/week pace instead
  // of being flattered down to Rp 30.000/week.
  //   weekly = spent this month / (days passed / 7)
  // Because it is the same rate, weekly === daily * 7 by construction.
  const weeksPassed = dayOfMonth / DAYS_PER_WEEK;
  const weeklyAverage = spentThisMonth / weeksPassed;

  return {
    dayOfMonth,
    spentThisMonth,
    incomeThisMonth,
    savingsThisMonth,
    spentByCategory,
    ledgerBalance,
    dailyAverage,
    weeklyAverage,
  };
};

/** Pure badge evaluation — see BADGES for the user-facing rules. */
const checkBadges = (
  transactions: Transaction[],
  weeklyAverage: number,
  dayOfMonth: number,
  monthlyBudget: number
) => {
  const earned: string[] = [];

  // Savior Badge: any expense logged in the Savings category.
  if (transactions.some((item) => item.kind === 'expense' && item.category === 'Savings')) {
    earned.push(BADGE_SAVIOR);
  }

  // Frugal Knight: a month is treated as 4 weeks, so a frugal week costs at most
  // 1/4 of the Monthly Budget Goal. We only judge after 7 days of data, otherwise
  // the tiny week-1 divisor would hand out the badge for free.
  const weeklyThreshold = monthlyBudget / 4;
  if (dayOfMonth >= DAYS_PER_WEEK && monthlyBudget > 0 && weeklyAverage < weeklyThreshold) {
    earned.push(BADGE_FRUGAL);
  }

  return earned;
};

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

/**
 * expo-notifications must NOT be imported at module scope.
 *
 * On Android the package's barrel file eagerly requires `TopicSubscriptionModule`,
 * which calls `requireNativeModule('ExpoTopicSubscriptionModule')`. That module is
 * missing in Expo Go and in any build made before the package was installed, and
 * `requireNativeModule` throws while the module graph is being evaluated. Because
 * that throw happens during the route module's own evaluation, the route ends up
 * with no default export — Expo Router then reports "missing the required default
 * export" and the screen blows up in the error boundary.
 *
 * Loading it lazily moves the failure to the moment reminders are actually enabled,
 * where it can be caught and reported instead of taking the whole dashboard down.
 */
type NotificationsApi = typeof import('expo-notifications');

let notificationsApiPromise: Promise<NotificationsApi | null> | null = null;
let notificationHandlerRegistered = false;

const loadNotifications = (): Promise<NotificationsApi | null> => {
  if (Platform.OS === 'web') return Promise.resolve(null);

  if (!notificationsApiPromise) {
    notificationsApiPromise = import('expo-notifications').catch((error) => {
      console.warn('[budget-rpg] Notifications are unavailable on this platform:', error);
      return null;
    });
  }

  return notificationsApiPromise;
};

/** Resolves to the notifications API, or `null` when its native module is missing. */
const getNotifications = async (): Promise<NotificationsApi | null> => {
  const api = await loadNotifications();
  if (!api) return null;

  if (!notificationHandlerRegistered) {
    notificationHandlerRegistered = true;
    // Lets reminders show up while the app is open. shouldShowAlert is deprecated in
    // SDK 57 in favour of the banner/list pair.
    api.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }

  return api;
};

/**
 * Creates the Android channel (required before the permission prompt can appear) and asks
 * for permission. Resolves to `null` when notifications are not supported by this build.
 */
const requestNotificationPermission = async (): Promise<boolean | null> => {
  const notifications = await getNotifications();
  if (!notifications) return null;

  if (Platform.OS === 'android') {
    await notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
      name: 'Budget Reminders',
      importance: notifications.AndroidImportance.HIGH,
      lightColor: COLORS.green,
    });
  }

  const existing = await notifications.getPermissionsAsync();
  if (existing.status === 'granted') return true;

  const requested = await notifications.requestPermissionsAsync();
  return requested.status === 'granted';
};

/**
 * Schedules the three recurring reminders and returns their notification ids,
 * or `null` when notifications are not supported by this build.
 */
const scheduleReminders = async (): Promise<ReminderIds | null> => {
  const notifications = await getNotifications();
  if (!notifications) return null;

  // Clear anything previously scheduled so re-enabling never duplicates.
  await notifications.cancelAllScheduledNotificationsAsync();

  // Monthly, on the 1st: nudge the user to set the Budget Plan for the new month.
  const monthly = await notifications.scheduleNotificationAsync({
    content: {
      title: '📜 New Month, New Quest',
      body: 'Set your Budget Plan and assign category targets before the spending starts.',
    },
    trigger: {
      type: notifications.SchedulableTriggerInputTypes.MONTHLY,
      day: 1,
      hour: REMINDER_HOUR,
      minute: 0,
    },
  });

  // Weekly, every Monday (weekday 1 = Sunday, so Monday = 2).
  const weekly = await notifications.scheduleNotificationAsync({
    content: {
      title: '💠 Mandatory Day',
      body: 'Time to pay the Mandatory categories: tithes, cemetery, house needs.',
    },
    trigger: {
      type: notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: 2,
      hour: REMINDER_HOUR,
      minute: 0,
    },
  });

  // Bi-weekly, every 14 days from the moment reminders are enabled.
  const biweekly = await notifications.scheduleNotificationAsync({
    content: {
      title: '🛡️ Feed the Vault',
      body: 'Allocate money to Savings to keep your Mana bar growing.',
    },
    trigger: {
      type: notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: BIWEEKLY_SECONDS,
      repeats: true,
    },
  });

  return { monthly, weekly, biweekly };
};

const clearReminders = async () => {
  const notifications = await getNotifications();
  if (!notifications) return;

  try {
    await notifications.cancelAllScheduledNotificationsAsync();
  } catch (error) {
    console.error('Failed to cancel reminders', error);
  }
};

/* ------------------------------------------------------------------ *
 * Presentational pieces
 * ------------------------------------------------------------------ */
function StatBar({
  label,
  valueLabel,
  percent,
  color,
  caption,
}: {
  label: string;
  valueLabel: string;
  percent: number;
  color: string;
  caption?: string;
}) {
  return (
    <View style={styles.statBarBlock}>
      <View style={styles.statBarHeader}>
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={[styles.statValue, { color }]}>{valueLabel}</Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[styles.barFill, { width: `${clampPercent(percent)}%`, backgroundColor: color }]}
        />
      </View>
      {caption ? <Text style={styles.statCaption}>{caption}</Text> : null}
    </View>
  );
}

function CategoryChips({
  selected,
  onSelect,
}: {
  selected: Category | null;
  onSelect: (category: Category) => void;
}) {
  return (
    <View style={styles.chipWrap}>
      {CATEGORIES.map((category) => {
        const active = category === selected;
        return (
          <TouchableOpacity
            key={category}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(category)}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {CATEGORY_ICONS[category]} {category}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SetupForm({
  startingBalance,
  monthlyBudget,
  submitLabel,
  onSubmit,
}: {
  startingBalance: number;
  monthlyBudget: number;
  submitLabel: string;
  onSubmit: (startingBalance: number, monthlyBudget: number) => void;
}) {
  const [balanceText, setBalanceText] = useState(startingBalance > 0 ? String(startingBalance) : '');
  const [budgetText, setBudgetText] = useState(monthlyBudget > 0 ? String(monthlyBudget) : '');

  const handleSubmit = () => {
    const balance = parseAmount(balanceText);
    const budget = parseAmount(budgetText);

    if (budget <= 0) {
      Alert.alert('Monthly Budget Goal needed', 'Enter the amount you can spend this month.');
      return;
    }

    onSubmit(balance, budget);
  };

  return (
    <View>
      <Text style={styles.fieldLabel}>Starting Total Balance</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 2500000"
        placeholderTextColor={COLORS.muted}
        keyboardType="numeric"
        value={balanceText}
        onChangeText={setBalanceText}
      />

      <Text style={styles.fieldLabel}>Monthly Budget Goal</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. 1500000"
        placeholderTextColor={COLORS.muted}
        keyboardType="numeric"
        value={budgetText}
        onChangeText={setBudgetText}
      />

      <TouchableOpacity style={styles.primaryButton} onPress={handleSubmit}>
        <Text style={styles.primaryButtonText}>{submitLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */
export default function HomeScreen() {
  const [isLoaded, setIsLoaded] = useState(false);

  // Profile / setup
  const [setupComplete, setSetupComplete] = useState(false);
  const [startingBalance, setStartingBalance] = useState(0);
  const [monthlyBudget, setMonthlyBudget] = useState(0);

  // Ledger
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categoryTargets, setCategoryTargets] = useState<CategoryTargets>({});

  // Achievements: badges already banked in storage. The ones the ledger currently
  // satisfies are derived below and merged in, so an unlock can never be lost.
  const [savedBadges, setSavedBadges] = useState<string[]>([]);

  // Reminders
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [reminderIds, setReminderIds] = useState<ReminderIds>(EMPTY_REMINDER_IDS);

  // UI state
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [planModalVisible, setPlanModalVisible] = useState(false);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [entryKind, setEntryKind] = useState<TransactionKind>('expense');
  const [entryTitle, setEntryTitle] = useState('');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryCategory, setEntryCategory] = useState<Category | null>(null);
  const [planDraft, setPlanDraft] = useState<Record<string, string>>({});

  /* ---------------- Load once ---------------- */
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as Partial<PersistedState>;

          if (typeof saved.startingBalance === 'number') setStartingBalance(saved.startingBalance);
          if (typeof saved.monthlyBudget === 'number') setMonthlyBudget(saved.monthlyBudget);
          if (Array.isArray(saved.transactions)) setTransactions(saved.transactions);
          if (saved.categoryTargets) setCategoryTargets(saved.categoryTargets);
          if (Array.isArray(saved.unlockedBadges)) setSavedBadges(saved.unlockedBadges);
          if (typeof saved.remindersEnabled === 'boolean') setRemindersEnabled(saved.remindersEnabled);
          if (saved.reminderIds) setReminderIds({ ...EMPTY_REMINDER_IDS, ...saved.reminderIds });

          setSetupComplete(Boolean(saved.setupComplete));
        }
      } catch (error) {
        console.error('Failed to load saved data', error);
      } finally {
        setIsLoaded(true);
      }
    })();
  }, []);

  /* ---------------- Derived stats ---------------- */
  // Re-running only on ledger changes is intentional: the date is read once per
  // change, which is plenty for day-of-month paced maths.
  const stats = useMemo(() => getMonthStats(transactions, new Date()), [transactions]);

  const earnedBadges = useMemo(
    () => checkBadges(transactions, stats.weeklyAverage, stats.dayOfMonth, monthlyBudget),
    [transactions, stats, monthlyBudget]
  );

  const unlockedBadges = useMemo(
    () => Array.from(new Set([...savedBadges, ...earnedBadges])),
    [savedBadges, earnedBadges]
  );

  const totalBalance = startingBalance + stats.ledgerBalance;
  const budgetLeft = monthlyBudget - stats.spentThisMonth;
  const hpPercent = monthlyBudget > 0 ? (budgetLeft / monthlyBudget) * 100 : 0;

  // Mana pools Income and Savings, scaled against the Monthly Budget Goal.
  const manaTotal = stats.incomeThisMonth + stats.savingsThisMonth;
  const manaPercent = monthlyBudget > 0 ? (manaTotal / monthlyBudget) * 100 : 0;

  const xp = transactions.length * XP_PER_LOG;
  const currentLevel = Math.floor(xp / XP_PER_LEVEL) + 1;

  const plannedTotal = Object.values(categoryTargets).reduce((sum, value) => sum + (value ?? 0), 0);
  const plannedCategories = CATEGORIES.filter((category) => (categoryTargets[category] ?? 0) > 0);

  /* ---------------- Persist ---------------- */
  useEffect(() => {
    if (!isLoaded) return;

    const payload: PersistedState = {
      setupComplete,
      startingBalance,
      monthlyBudget,
      transactions,
      categoryTargets,
      unlockedBadges,
      remindersEnabled,
      reminderIds,
    };

    (async () => {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (error) {
        console.error('Failed to save data', error);
      }
    })();
  }, [
    isLoaded,
    setupComplete,
    startingBalance,
    monthlyBudget,
    transactions,
    categoryTargets,
    unlockedBadges,
    remindersEnabled,
    reminderIds,
  ]);

  /* ---------------- Handlers ---------------- */
  const handleSetupSubmit = (balance: number, budget: number) => {
    setStartingBalance(balance);
    setMonthlyBudget(budget);
    setSetupComplete(true);
    setSettingsModalVisible(false);
  };

  const openLogModal = (kind: TransactionKind) => {
    setEntryKind(kind);
    setEntryTitle('');
    setEntryAmount('');
    setEntryCategory(null);
    setLogModalVisible(true);
  };

  const handleSaveEntry = () => {
    const amount = parseAmount(entryAmount);
    const isExpense = entryKind === 'expense';
    const category = isExpense ? entryCategory : null;

    if (amount <= 0) {
      Alert.alert('Amount needed', 'Enter an amount greater than zero.');
      return;
    }
    if (isExpense && !category) {
      Alert.alert('Pick a category', 'Every expense needs a category.');
      return;
    }

    const title = entryTitle.trim();
    const entry: Transaction = {
      // Two entries can be logged in the same millisecond, so pair the timestamp
      // with random characters to keep FlatList keys unique.
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: title.length > 0 ? title : (category ?? 'Income'),
      amount,
      category,
      kind: entryKind,
      date: Date.now(),
    };

    setTransactions((prev) => [entry, ...prev]);
    setLogModalVisible(false);
  };

  const openPlanModal = () => {
    const draft: Record<string, string> = {};
    for (const category of CATEGORIES) {
      const target = categoryTargets[category];
      draft[category] = target ? String(target) : '';
    }
    setPlanDraft(draft);
    setPlanModalVisible(true);
  };

  const handleSavePlan = () => {
    const next: CategoryTargets = {};
    for (const category of CATEGORIES) {
      const target = parseAmount(planDraft[category] ?? '');
      if (target > 0) next[category] = target;
    }
    setCategoryTargets(next);
    setPlanModalVisible(false);
  };

  const handleEnableReminders = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not available on web', 'Reminders need a device build of the app.');
      return;
    }

    try {
      const granted = await requestNotificationPermission();

      if (granted === null) {
        Alert.alert(
          'Notifications unavailable',
          'This build has no notification support. Use a development build (npx expo run:android, or eas build --profile development) to enable reminders.'
        );
        return;
      }

      if (!granted) {
        Alert.alert('Permission needed', 'Allow notifications to receive budget reminders.');
        return;
      }

      const ids = await scheduleReminders();
      if (!ids) return;

      setReminderIds(ids);
      setRemindersEnabled(true);
      Alert.alert(
        'Reminders scheduled',
        'Monthly budget plan, weekly mandatory payments and bi-weekly savings nudges are now active.'
      );
    } catch (error) {
      console.error('Failed to schedule reminders', error);
      Alert.alert('Could not schedule', 'Something went wrong while scheduling reminders.');
    }
  };

  const handleDisableReminders = async () => {
    await clearReminders();
    setReminderIds(EMPTY_REMINDER_IDS);
    setRemindersEnabled(false);
  };

  /* ---------------- Render ---------------- */
  if (!isLoaded) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar style="dark" />
        <View style={styles.centerBox}>
          <Text style={styles.mutedText}>Summoning your ledger…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!setupComplete) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.setupScreen} keyboardShouldPersistTaps="handled">
          <Text style={styles.setupEmoji}>🐕</Text>
          <Text style={styles.setupTitle}>Budget Explorer</Text>
          <Text style={styles.setupSubtitle}>
            Set your starting stats to begin the run. Everything is stored on this device only.
          </Text>
          <SetupForm
            startingBalance={startingBalance}
            monthlyBudget={monthlyBudget}
            submitLabel="🚀 Start the Run"
            onSubmit={handleSetupSubmit}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  const renderTransaction: ListRenderItem<Transaction> = ({ item }) => {
    const isIncome = item.kind === 'income';
    return (
      <View style={styles.transactionItem}>
        <View style={styles.transactionMain}>
          <Text style={styles.transactionTitle}>{item.title}</Text>
          <Text style={styles.transactionMeta}>
            {isIncome
              ? '💰 Income'
              : `${CATEGORY_ICONS[item.category ?? 'Other (Unexpected)']} ${item.category}`}
            {' • '}
            {new Date(item.date).toLocaleDateString('id-ID')}
          </Text>
        </View>
        <Text style={[styles.transactionAmount, isIncome && styles.transactionAmountIncome]}>
          {isIncome ? '+' : '-'} {formatRupiah(item.amount)}
        </Text>
      </View>
    );
  };

  const header = (
    <View>
      {/* 1. Profile */}
      <View style={styles.profileSection}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarEmoji}>🐕</Text>
        </View>
        <View style={styles.levelInfo}>
          <Text style={styles.playerName}>Budget Explorer</Text>
          <Text style={styles.levelText}>
            Level {currentLevel} • {xp} XP
          </Text>
        </View>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => setSettingsModalVisible(true)}
          accessibilityLabel="Open settings"
        >
          <Text style={styles.iconButtonText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* 2. Balance + the two RPG bars */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Total Balance</Text>
        <Text style={styles.balanceAmount}>{formatRupiah(totalBalance)}</Text>

        <StatBar
          label="Monthly HP (Budget Health)"
          valueLabel={formatRupiah(Math.max(0, budgetLeft))}
          percent={hpPercent}
          // HP turns red once less than a fifth of the budget is left.
          color={hpPercent > 20 ? COLORS.green : COLORS.red}
          caption={`${clampPercent(hpPercent).toFixed(1)}% of ${formatRupiah(monthlyBudget)} left · spent ${formatRupiah(stats.spentThisMonth)}`}
        />

        <StatBar
          label="Mana (Income + Savings)"
          valueLabel={formatRupiah(manaTotal)}
          percent={manaPercent}
          color={COLORS.brownBright}
          caption={`Income ${formatRupiah(stats.incomeThisMonth)} · Savings ${formatRupiah(stats.savingsThisMonth)}`}
        />
      </View>

      {/* 3. Log actions */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionButton, styles.expenseButton]}
          onPress={() => openLogModal('expense')}
        >
          <Text style={styles.actionButtonText}>⚔️ Log Expense</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionButton, styles.incomeButton]}
          onPress={() => openLogModal('income')}
        >
          <Text style={styles.actionButtonText}>💰 Log Income</Text>
        </TouchableOpacity>
      </View>

      {/* 4. Frequency / average stats panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Stats Panel</Text>
        <View style={styles.statGrid}>
          <View style={styles.statCell}>
            <Text style={styles.statCellLabel}>Daily Average Spent</Text>
            <Text style={styles.statCellValue}>{formatRupiah(round(stats.dailyAverage))}</Text>
            <Text style={styles.statCellHint}>
              {formatRupiah(stats.spentThisMonth)} / day {stats.dayOfMonth}
            </Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellLabel}>Weekly Average Spent</Text>
            <Text style={styles.statCellValue}>{formatRupiah(round(stats.weeklyAverage))}</Text>
            <Text style={styles.statCellHint}>
              {(stats.dayOfMonth / DAYS_PER_WEEK).toFixed(1)} weeks passed
            </Text>
          </View>
        </View>
      </View>

      {/* 5. Achievements */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Achievements</Text>
        {BADGES.map((badge) => {
          const unlocked = unlockedBadges.includes(badge.id);
          return (
            <View key={badge.id} style={[styles.badgeRow, !unlocked && styles.badgeRowLocked]}>
              <Text style={styles.badgeIcon}>{unlocked ? badge.icon : '🔒'}</Text>
              <View style={styles.badgeInfo}>
                <Text style={[styles.badgeName, !unlocked && styles.badgeNameLocked]}>
                  {badge.name}
                </Text>
                <Text style={styles.badgeHint}>{badge.hint}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* 6. Budget Plan Tracker */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Budget Plan Tracker</Text>
          <TouchableOpacity style={styles.smallButton} onPress={openPlanModal}>
            <Text style={styles.smallButtonText}>Edit Plan</Text>
          </TouchableOpacity>
        </View>

        {plannedCategories.length === 0 ? (
          <Text style={styles.mutedText}>
            No category targets yet. Set a Budget Plan to track planned spending.
          </Text>
        ) : (
          <>
            <Text style={styles.planSummary}>
              Planned {formatRupiah(plannedTotal)} of {formatRupiah(monthlyBudget)} budget goal
            </Text>
            {plannedCategories.map((category) => {
              const target = categoryTargets[category] ?? 0;
              const spent = stats.spentByCategory[category] ?? 0;
              const percent = target > 0 ? (spent / target) * 100 : 0;
              const over = spent > target;
              return (
                <View key={category} style={styles.planRow}>
                  <View style={styles.planRowHeader}>
                    <Text style={styles.planName}>
                      {CATEGORY_ICONS[category]} {category}
                    </Text>
                    <Text style={[styles.planValue, over && styles.planValueOver]}>
                      {formatRupiah(spent)} / {formatRupiah(target)}
                    </Text>
                  </View>
                  <View style={styles.miniBarTrack}>
                    <View
                      style={[
                        styles.miniBarFill,
                        {
                          width: `${clampPercent(percent)}%`,
                          backgroundColor: over ? COLORS.red : COLORS.green,
                        },
                      ]}
                    />
                  </View>
                </View>
              );
            })}
          </>
        )}
      </View>

      {/* 7. Reminders */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Reminders</Text>
        <Text style={styles.reminderLine}>📅 Monthly: set your Budget Plan</Text>
        <Text style={styles.reminderLine}>💠 Weekly: pay Mandatory categories (tithes / house)</Text>
        <Text style={styles.reminderLine}>🛡️ Bi-weekly: allocate money to Savings</Text>
        <TouchableOpacity
          style={[styles.primaryButton, remindersEnabled && styles.secondaryButton]}
          onPress={remindersEnabled ? handleDisableReminders : handleEnableReminders}
        >
          <Text
            style={[
              styles.primaryButtonText,
              remindersEnabled && styles.secondaryButtonText,
            ]}
          >
            {remindersEnabled ? 'Turn Reminders Off' : 'Enable Reminders'}
          </Text>
        </TouchableOpacity>
        {remindersEnabled && reminderIds.monthly ? (
          <Text style={styles.statCaption}>Scheduled on this device. All times are 09:00 local.</Text>
        ) : null}
      </View>

      <Text style={styles.historyTitle}>Recent Battles (Ledger)</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        ListHeaderComponent={header}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.emptyText}>No entries yet. Your HP is safe and untouched.</Text>
        }
      />

      {/* ---------------- Log entry modal ---------------- */}
      <Modal
        animationType="slide"
        transparent
        visible={logModalVisible}
        onRequestClose={() => setLogModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.sheet}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>
                {entryKind === 'expense' ? '⚔️ Log Expense' : '💰 Log Income'}
              </Text>

              <View style={styles.segmentRow}>
                {(['expense', 'income'] as const).map((kind) => (
                  <TouchableOpacity
                    key={kind}
                    style={[styles.segment, entryKind === kind && styles.segmentActive]}
                    onPress={() => setEntryKind(kind)}
                  >
                    <Text
                      style={[styles.segmentText, entryKind === kind && styles.segmentTextActive]}
                    >
                      {kind === 'expense' ? 'Expense' : 'Income'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput
                style={styles.input}
                placeholder={entryKind === 'expense' ? 'What did you buy?' : 'Where did it come from?'}
                placeholderTextColor={COLORS.muted}
                value={entryTitle}
                onChangeText={setEntryTitle}
              />

              <Text style={styles.fieldLabel}>Amount</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 50000"
                placeholderTextColor={COLORS.muted}
                keyboardType="numeric"
                value={entryAmount}
                onChangeText={setEntryAmount}
              />

              {entryKind === 'expense' ? (
                <>
                  <Text style={styles.fieldLabel}>Category</Text>
                  <CategoryChips selected={entryCategory} onSelect={setEntryCategory} />
                </>
              ) : null}

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.cancelBtn]}
                  onPress={() => setLogModalVisible(false)}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalBtn, styles.saveBtn]} onPress={handleSaveEntry}>
                  <Text style={styles.saveBtnText}>Save &amp; Strike!</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ---------------- Budget plan modal ---------------- */}
      <Modal
        animationType="slide"
        transparent
        visible={planModalVisible}
        onRequestClose={() => setPlanModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.sheet}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>📜 Budget Plan</Text>
              <Text style={styles.modalHint}>
                Leave a category empty to skip it. Planned totals are compared against your Monthly
                Budget Goal on the dashboard card.
              </Text>

              {CATEGORIES.map((category) => (
                <View key={category}>
                  <Text style={styles.fieldLabel}>
                    {CATEGORY_ICONS[category]} {category}
                  </Text>
                  <TextInput
                    style={styles.input}
                    placeholder="No target"
                    placeholderTextColor={COLORS.muted}
                    keyboardType="numeric"
                    value={planDraft[category] ?? ''}
                    onChangeText={(text) =>
                      setPlanDraft((prev) => ({ ...prev, [category]: text }))
                    }
                  />
                </View>
              ))}

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.cancelBtn]}
                  onPress={() => setPlanModalVisible(false)}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalBtn, styles.saveBtn]} onPress={handleSavePlan}>
                  <Text style={styles.saveBtnText}>Save Plan</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ---------------- Settings modal ---------------- */}
      <Modal
        animationType="slide"
        transparent
        visible={settingsModalVisible}
        onRequestClose={() => setSettingsModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.sheet}>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalTitle}>⚙️ Player Stats</Text>
              <Text style={styles.modalHint}>
                Update your starting balance or monthly budget goal at any time. Existing entries are
                kept.
              </Text>

              <SetupForm
                startingBalance={startingBalance}
                monthlyBudget={monthlyBudget}
                submitLabel="Save Changes"
                onSubmit={handleSetupSubmit}
              />

              <TouchableOpacity
                style={[styles.primaryButton, styles.secondaryButton, styles.cancelSpacing]}
                onPress={() => setSettingsModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    paddingHorizontal: 20,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mutedText: { color: COLORS.muted, fontSize: 14 },
  listContent: { paddingBottom: BottomTabInset + 24 },

  /* Setup screen */
  setupScreen: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 40,
  },
  setupEmoji: { fontSize: 56, textAlign: 'center' },
  setupTitle: {
    fontSize: 26,
    fontWeight: 'bold',
    color: COLORS.text,
    textAlign: 'center',
    marginTop: 12,
  },
  setupSubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 24,
    lineHeight: 20,
  },

  /* Profile */
  profileSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 20,
  },
  avatarCircle: {
    width: 60,
    height: 60,
    backgroundColor: COLORS.greenSoft,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: COLORS.green,
  },
  avatarEmoji: { fontSize: 30 },
  levelInfo: { marginLeft: 15, flex: 1 },
  playerName: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  levelText: { fontSize: 14, color: COLORS.green, fontWeight: 'bold', marginTop: 4 },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  iconButtonText: { fontSize: 20 },

  /* Cards */
  card: {
    backgroundColor: COLORS.surface,
    padding: 20,
    borderRadius: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    ...Platform.select({
      ios: {
        shadowColor: COLORS.shadow,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.08,
        shadowRadius: 14,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitle: {
    color: COLORS.muted,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
  },
  balanceAmount: {
    fontSize: 32,
    fontWeight: 'bold',
    color: COLORS.text,
    marginTop: 8,
    marginBottom: 18,
  },

  /* Stat bars */
  statBarBlock: { marginBottom: 16 },
  statBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statLabel: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  statValue: { fontSize: 14, fontWeight: 'bold' },
  barTrack: {
    height: 14,
    backgroundColor: COLORS.well,
    borderRadius: 7,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 7 },
  statCaption: { color: COLORS.muted, fontSize: 11, marginTop: 6 },

  /* Action buttons */
  actionRow: { flexDirection: 'row', marginBottom: 20 },
  actionButton: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    elevation: 5,
  },
  expenseButton: { backgroundColor: COLORS.greenDark, marginRight: 8 },
  incomeButton: { backgroundColor: COLORS.brown, marginLeft: 8 },
  actionButtonText: { color: COLORS.onColor, fontSize: 15, fontWeight: 'bold' },

  /* Stats panel */
  statGrid: { flexDirection: 'row', marginTop: 14 },
  statCell: {
    flex: 1,
    backgroundColor: COLORS.well,
    borderRadius: 14,
    padding: 14,
    marginRight: 8,
  },
  statCellLabel: { color: COLORS.muted, fontSize: 11, textTransform: 'uppercase' },
  statCellValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 6,
  },
  statCellHint: { color: COLORS.muted, fontSize: 11, marginTop: 4 },

  /* Achievements */
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.greenSoft,
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: COLORS.greenEdge,
  },
  badgeRowLocked: {
    backgroundColor: COLORS.well,
    borderColor: COLORS.border,
    opacity: 0.75,
  },
  badgeIcon: { fontSize: 26, marginRight: 12 },
  badgeInfo: { flex: 1 },
  badgeName: { color: COLORS.green, fontSize: 15, fontWeight: 'bold' },
  badgeNameLocked: { color: COLORS.muted },
  badgeHint: { color: COLORS.muted, fontSize: 12, marginTop: 4, lineHeight: 17 },

  /* Plan tracker */
  planSummary: { color: COLORS.muted, fontSize: 12, marginBottom: 14 },
  planRow: { marginBottom: 14 },
  planRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  planName: { color: COLORS.text, fontSize: 13, flex: 1, marginRight: 8 },
  planValue: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  planValueOver: { color: COLORS.red },
  miniBarTrack: {
    height: 8,
    backgroundColor: COLORS.well,
    borderRadius: 4,
    overflow: 'hidden',
  },
  miniBarFill: { height: '100%', borderRadius: 4 },
  smallButton: {
    backgroundColor: COLORS.greenDark,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  smallButtonText: { color: COLORS.onColor, fontSize: 12, fontWeight: 'bold' },

  /* Reminders */
  reminderLine: { color: COLORS.text, fontSize: 13, marginTop: 10 },

  /* Ledger */
  historyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 14,
  },
  transactionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: 15,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  transactionMain: { flex: 1, marginRight: 12 },
  transactionTitle: { color: COLORS.text, fontSize: 16, fontWeight: '600' },
  transactionMeta: { color: COLORS.muted, fontSize: 12, marginTop: 4 },
  transactionAmount: { color: COLORS.red, fontSize: 15, fontWeight: 'bold' },
  transactionAmountIncome: { color: COLORS.green },
  emptyText: {
    color: COLORS.muted,
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },

  /* Modals */
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.scrim,
  },
  sheet: {
    maxHeight: '90%',
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  modalHint: { color: COLORS.muted, fontSize: 12, marginBottom: 16, lineHeight: 18 },
  fieldLabel: {
    color: COLORS.muted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  input: {
    backgroundColor: COLORS.well,
    color: COLORS.text,
    padding: 15,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    fontSize: 16,
  },

  /* Segmented control */
  segmentRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.well,
    borderRadius: 12,
    padding: 4,
    marginBottom: 18,
  },
  segment: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segmentActive: { backgroundColor: COLORS.surface },
  segmentText: { color: COLORS.muted, fontWeight: '600' },
  segmentTextActive: { color: COLORS.greenDark },

  /* Category chips */
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  chip: {
    backgroundColor: COLORS.well,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  chipText: { color: COLORS.text, fontSize: 13 },
  chipTextActive: { color: COLORS.onColor, fontWeight: 'bold' },

  /* Modal buttons */
  primaryButton: {
    backgroundColor: COLORS.green,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  primaryButtonText: { color: COLORS.onColor, fontSize: 16, fontWeight: 'bold' },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.green,
  },
  secondaryButtonText: { color: COLORS.greenDark, fontSize: 16, fontWeight: 'bold' },
  cancelSpacing: { marginTop: 16 },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  modalBtn: { flex: 1, padding: 15, borderRadius: 12, alignItems: 'center' },
  cancelBtn: { backgroundColor: COLORS.well, marginRight: 10 },
  saveBtn: { backgroundColor: COLORS.green, marginLeft: 10 },
  cancelBtnText: { color: COLORS.text, fontWeight: 'bold', fontSize: 16 },
  saveBtnText: { color: COLORS.onColor, fontWeight: 'bold', fontSize: 16 },
});
