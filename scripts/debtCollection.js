export class DebtCollectionScripts {
  static getScript(stage, clientResponse, clientData = {}) {
    const variants = this.getResponseVariants(
      stage,
      clientResponse,
      clientData
    );
    return variants && variants.length > 0
      ? variants[0]
      : this.getFallbackScript();
  }

  static classifyResponse(transcription = '') {
    const text = transcription.toLowerCase();

    if (text.includes('да') || text.includes('согласен')) return 'positive';
    if (text.includes('нет') || text.includes('не буду')) return 'negative';
    if (text.includes('суд') || text.includes('долг')) return 'aggressive';
    if (text.includes('пока') || text.includes('до свидания')) return 'hang_up';
    if (text.trim() === '') return 'silence';

    return 'neutral';
  }

  static getResponseVariants(stage, classification, clientData = {}) {
    const allVariants = this.getAllResponseVariants();

    const stageVariants = allVariants[stage] || allVariants['listening'];
    const classificationVariants = stageVariants[classification];

    if (!classificationVariants || classificationVariants.length === 0) {
      return [this.getFallbackScript()];
    }

    // Персонализируем ответы данными клиента
    return classificationVariants.map((variant) => ({
      ...variant,
      text: this.personalizeText(variant.text, clientData),
    }));
  }

  /**
   * Все варианты ответов для разных ситуаций
   */
  static getAllResponseVariants() {
    return {
      // === ЭТАП: НАЧАЛО РАЗГОВОРА ===
      start: {
        positive: [
          {
            text: 'Добрый день! Меня зовут МИИИхал, я представляю компанию {company}. Могу ли я говорить с {clientName}?',
            nextStage: 'identification',
            priority: 'normal',
          },
          {
            text: 'Здравствуйте! Это МИИИхал из {company}. Вы {clientName}?',
            nextStage: 'identification',
            priority: 'normal',
          },
          {
            text: 'Добро пожаловать! Меня зовут МИИИхал, звоню из компании {company}. Я правильно дозвонился до {clientName}?',
            nextStage: 'identification',
            priority: 'normal',
          },
        ],
        negative: [
          {
            text: 'Понимаю ваше беспокойство. Это важный звонок касательно финансовых обязательств. Могу я говорить с заемщиком?',
            nextStage: 'identification',
            priority: 'high',
          },
          {
            text: 'Я понимаю, что звонки могут раздражать. Но это касается важных документов. Можете подтвердить, что я говорю с {clientName}?',
            nextStage: 'identification',
            priority: 'high',
          },
        ],
        neutral: [
          {
            text: 'Здравствуйте! Меня зовут МИИИхал. Я правильно дозвонился до {clientName}?',
            nextStage: 'identification',
            priority: 'normal',
          },
        ],
      },

      // === ЭТАП: СЛУШАНИЕ/ОСНОВНОЙ ДИАЛОГ ===
      listening: {
        neutral: [
          {
            text: 'Не могли бы вы уточнить свою позицию по погашению задолженности?',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Я хотел бы понять ваше видение ситуации с долгом на {amount} рублей.',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Расскажите, как планируете решать вопрос с задолженностью?',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Какие у вас предложения по урегулированию долга?',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Помогите мне понять вашу позицию по данному вопросу.',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Что можете предложить для погашения задолженности?',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Давайте найдём взаимовыгодное решение по долгу.',
            nextStage: 'negotiation',
            priority: 'normal',
          },
        ],

        aggressive: [
          {
            text: 'Прошу вас сохранять спокойствие. Мы можем решить этот вопрос мирно.',
            nextStage: 'de_escalation',
            priority: 'urgent',
          },
          {
            text: 'Понимаю, что тема неприятная, но давайте обсудим конструктивно.',
            nextStage: 'de_escalation',
            priority: 'urgent',
          },
          {
            text: 'Крики не решат проблему. Предлагаю спокойно поговорить о долге.',
            nextStage: 'de_escalation',
            priority: 'urgent',
          },
          {
            text: 'Я здесь, чтобы помочь найти решение, а не создать конфликт.',
            nextStage: 'de_escalation',
            priority: 'urgent',
          },
          {
            text: 'Ваши эмоции понятны, но лучше направить энергию на решение вопроса.',
            nextStage: 'de_escalation',
            priority: 'urgent',
          },
          {
            text: 'Предлагаю переключиться на поиск выхода из ситуации с долгом.',
            nextStage: 'negotiation',
            priority: 'urgent',
          },
        ],

        positive: [
          {
            text: 'Отлично! Давайте обсудим детали погашения долга на {amount} рублей.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
          {
            text: 'Прекрасно, что готовы к сотрудничеству! Когда можете приступить к погашению?',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
          {
            text: 'Замечательный настрой! Обсудим варианты оплаты задолженности.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
        ],

        negative: [
          {
            text: 'Понимаю ваше положение. Давайте найдем компромиссное решение.',
            nextStage: 'negotiation',
            priority: 'high',
          },
          {
            text: 'Финансовые трудности бывают у всех. Рассмотрим варианты рассрочки.',
            nextStage: 'negotiation',
            priority: 'high',
          },
          {
            text: 'Отказ понятен, но проблема никуда не денется. Найдём выход вместе.',
            nextStage: 'negotiation',
            priority: 'high',
          },
          {
            text: 'Не спешите отказываться. Есть разные способы решения вопроса.',
            nextStage: 'negotiation',
            priority: 'high',
          },
        ],

        hang_up: [
          {
            text: 'Спасибо за разговор. До свидания.',
            nextStage: 'completed',
            priority: 'normal',
          },
          {
            text: 'Понял ваше решение. Всего доброго.',
            nextStage: 'completed',
            priority: 'normal',
          },
          {
            text: 'До встречи! Надеюсь на дальнейшее сотрудничество.',
            nextStage: 'completed',
            priority: 'normal',
          },
        ],
      },

      // === ЭТАП: ДЕЭСКАЛАЦИЯ ===
      de_escalation: {
        aggressive: [
          {
            text: 'Понимаю ваше раздражение. Никто не хочет таких звонков. Но давайте решим быстро.',
            nextStage: 'negotiation',
            priority: 'urgent',
          },
          {
            text: 'Извините за беспокойство. Цель - найти решение, которое устроит всех.',
            nextStage: 'negotiation',
            priority: 'urgent',
          },
          {
            text: 'Не хочу усложнять вашу ситуацию. Просто нужно урегулировать формальности.',
            nextStage: 'payment_discussion',
            priority: 'urgent',
          },
        ],

        neutral: [
          {
            text: 'Давайте вернёмся к обсуждению задолженности на {amount} рублей.',
            nextStage: 'listening',
            priority: 'normal',
          },
          {
            text: 'Предлагаю сосредоточиться на решении вопроса с долгом.',
            nextStage: 'listening',
            priority: 'normal',
          },
        ],
      },

      // === ЭТАП: ПЕРЕГОВОРЫ ===
      negotiation: {
        positive: [
          {
            text: 'Отлично! Рассмотрим удобный для вас график платежей.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
          {
            text: 'Хорошо, что настроены конструктивно. Обсудим детали.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
        ],

        negative: [
          {
            text: 'Понимаю сложности. Можем разбить сумму на части - по {partialAmount} рублей в месяц.',
            nextStage: 'negotiation',
            priority: 'high',
          },
          {
            text: 'Полный отказ усложнит ситуацию. Рассмотрите хотя бы частичную оплату.',
            nextStage: 'escalation',
            priority: 'high',
          },
          {
            text: 'Без решения вопрос перейдёт в правовую плоскость. Этого можно избежать.',
            nextStage: 'escalation',
            priority: 'high',
          },
        ],

        neutral: [
          {
            text: 'Давайте найдём реальное решение. Какую сумму можете платить ежемесячно?',
            nextStage: 'negotiation',
            priority: 'normal',
          },
          {
            text: 'Важно найти баланс между вашими возможностями и обязательствами.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
        ],
      },

      // === ЭТАП: ЭСКАЛАЦИЯ ===
      escalation: {
        positive: [
          {
            text: 'Рад, что готовы к диалогу. Вернёмся к обсуждению вариантов оплаты.',
            nextStage: 'payment_discussion',
            priority: 'normal',
          },
        ],

        negative: [
          {
            text: 'К сожалению, при отказе дело передаётся в суд. Это последняя возможность решить мирно.',
            nextStage: 'final_warning',
            priority: 'urgent',
          },
          {
            text: 'Понимаю нежелание, но судебные издержки увеличат сумму в разы. Давайте договоримся.',
            nextStage: 'final_warning',
            priority: 'urgent',
          },
        ],

        aggressive: [
          {
            text: 'При продолжении неподобающего поведения разговор будет завершён. Последний раз предлагаю решить вопрос.',
            nextStage: 'final_warning',
            priority: 'urgent',
          },
        ],
      },

      // === ЭТАП: ФИНАЛЬНОЕ ПРЕДУПРЕЖДЕНИЕ ===
      final_warning: {
        positive: [
          {
            text: 'Отлично! Фиксирую ваше согласие. Реквизиты для оплаты отправлю на номер.',
            nextStage: 'completed',
            priority: 'normal',
          },
        ],

        negative: [
          {
            text: 'Сожалею, но вопрос передаётся в правовой отдел. До свидания.',
            nextStage: 'completed',
            priority: 'urgent',
          },
        ],

        hang_up: [
          {
            text: 'До свидания. Дальнейшие решения принимает правовой отдел.',
            nextStage: 'completed',
            priority: 'normal',
          },
        ],
      },
    };
  }

  /**
   * Персонализация текста данными клиента
   */
  static personalizeText(text, clientData = {}) {
    let personalizedText = text;

    const replacements = {
      '{clientName}': clientData.name || 'клиент',
      '{company}': clientData.company || 'Финанс-Сервис',
      '{amount}': clientData.amount || 'указанную в договоре',
      '{contract}': clientData.contract || 'согласно документам',
      '{partialAmount}': clientData.amount
        ? Math.ceil(clientData.amount / 6)
        : '2,500',
    };

    for (const [placeholder, value] of Object.entries(replacements)) {
      personalizedText = personalizedText.replace(
        new RegExp(placeholder, 'g'),
        value
      );
    }

    return personalizedText;
  }

  /**
   * Получить фолбэк скрипт при ошибках
   */
  static getFallbackScript() {
    return {
      text: 'Не совсем понял вашу реакцию. Можете повторить?',
      nextStage: 'listening',
      priority: 'high',
    };
  }

  /**
   * Классификация ответа (улучшенная версия)
   */
  static classifyResponse(transcription = '') {
    const text = transcription.toLowerCase().trim();

    // Пустой или очень короткий ответ
    if (text.length < 3) {
      return 'neutral';
    }

    const classificationRules = [
      // ПОЗИТИВНЫЕ
      {
        type: 'positive',
        patterns: [
          /\b(да|хорошо|согласен|договорились|ладно|окей|понятно|конечно)\b/,
          /\b(буду|заплачу|оплачу|верну|погашу|готов)\b/,
          /\b(можем|давайте|обсудим|рассмотрим)\b/,
        ],
        weight: 2,
      },

      // НЕГАТИВНЫЕ
      {
        type: 'negative',
        patterns: [
          /\b(нет|не буду|не могу|отказываюсь|невозможно)\b/,
          /\b(денег нет|нечем платить|без денег|не работаю)\b/,
          /\b(не хочу|не буду|забудьте)\b/,
        ],
        weight: 2,
      },

      // АГРЕССИВНЫЕ
      {
        type: 'aggressive',
        patterns: [
          /\b(блять|сука|хуй|пиздец|ебать|мудак|урод)\b/,
          /\b(отъебись|отвали|иди нахуй|пошёл|заебал)\b/,
          /\b(найду|убью|приеду|разберусь)\b/,
        ],
        weight: 3,
      },

      // ЗАВЕРШЕНИЕ
      {
        type: 'hang_up',
        patterns: [
          /\b(до свидания|пока|кладу трубку|до встречи|всего доброго)\b/,
          /\b(отключаюсь|конец|закончили|хватит)\b/,
        ],
        weight: 3,
      },
    ];

    let scores = {
      positive: 0,
      negative: 0,
      aggressive: 0,
      hang_up: 0,
      neutral: 1,
    };

    // Подсчёт очков по правилам
    for (const rule of classificationRules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(text)) {
          scores[rule.type] += rule.weight;
        }
      }
    }

    // Поиск максимального значения
    const maxScore = Math.max(...Object.values(scores));
    const classification = Object.keys(scores).find(
      (key) => scores[key] === maxScore
    );

    return classification || 'neutral';
  }

  /**
   * Получить случайное приветствие
   */
  static getRandomGreeting() {
    const greetings = [
      'Добрый день!',
      'Здравствуйте!',
      'Доброе утро!',
      'Добро пожаловать!',
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  /**
   * Определить критичность ситуации
   */
  static isCriticalSituation(classification, message) {
    const criticalKeywords = [
      'суд',
      'полиция',
      'прокуратура',
      'юрист',
      'адвокат',
      'убью',
      'найду',
      'приеду',
      'разберусь',
    ];

    return (
      criticalKeywords.some((keyword) =>
        message.toLowerCase().includes(keyword)
      ) || classification === 'threat'
    );
  }

  /**
   * Проверка на попытку смены темы
   */
  static isOffTopicAttempt(message) {
    const offTopicPatterns = [
      /как дела|что нового|как жизнь/i,
      /погода|дождь|солнце|снег/i,
      /футбол|спорт|игра/i,
      /работа|семья|дети/i,
      /продолжение следует|с вами был/i,
      /меня зовут|я работаю/i,
    ];

    return offTopicPatterns.some((pattern) => pattern.test(message));
  }
}
