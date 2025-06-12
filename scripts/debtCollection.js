export class DebtCollectionScripts {
  static getScript(stage, clientResponse, clientData = {}) {
    const scripts = {
      start: {
        positive: {
          text: `Добрый день! Меня зовут Анна, я представляю компанию ${
            clientData.company || "Финанс-Сервис"
          }. Могу ли я говорить с ${clientData.name || "заемщиком"}?`,
          nextStage: "identification",
          priority: "normal",
        },
        negative: {
          text: "Добрый день! Это важный звонок касательно финансовых обязательств. Могу ли я говорить с заемщиком?",
          nextStage: "identification",
          priority: "high",
        },
      },
      identification: {
        positive: {
          text: `Благодарю за подтверждение. Я сотрудник отдела взыскания компании ${
            clientData.company || "Финанс-Сервис"
          }. Звоню по поводу задолженности по договору ${
            clientData.contract || "номер указан в документах"
          }.`,
          nextStage: "debt_discussion",
          priority: "normal",
        },
        negative: {
          text: "Понимаю ваше беспокойство. Это касается важных финансовых обязательств. Для конфиденциальности мне нужно убедиться, что говорю с заемщиком.",
          nextStage: "identification",
          priority: "high",
        },
        aggressive: {
          text: "Понимаю, что ситуация неприятна. Не хочу причинять дискомфорт. Цель звонка - найти решение. Давайте спокойно обсудим.",
          nextStage: "debt_discussion",
          priority: "urgent",
        },
      },
      debt_discussion: {
        positive: {
          text: `Отлично, что помните займ. Текущая сумма к погашению составляет ${
            clientData.amount || "указанную в договоре"
          } рублей. Обсудим варианты погашения.`,
          nextStage: "payment_offer",
          priority: "normal",
        },
        negative: {
          text: `Понимаю недоумение. Займ оформлен по договору ${
            clientData.contract || ""
          }, сумма ${
            clientData.amount || ""
          } рублей. Возможно, помните под другим названием?`,
          nextStage: "debt_discussion",
          priority: "high",
        },
        aggressive: {
          text: "Понимаю раздражение. Никто не хочет такие звонки. Но раз ситуация возникла, найдем способ решить быстро без проблем.",
          nextStage: "payment_offer",
          priority: "urgent",
        },
      },
      payment_offer: {
        positive: {
          text: `Прекрасно! Для погашения ${
            clientData.amount || "суммы"
          } рублей можете использовать перевод по реквизитам или онлайн-банкинг. Когда планируете оплату?`,
          nextStage: "payment_confirmation",
          priority: "normal",
        },
        negative: {
          text: "Понимаю, что сразу может быть сложно. Предлагаю рассрочку - частями в течение нескольких месяцев. Это снизит финансовую нагрузку.",
          nextStage: "payment_offer",
          priority: "high",
        },
        aggressive: {
          text: "Понимаю нежелание платить. Должен предупредить: без погашения дело передается в суд. Это дополнительные расходы. Давайте найдем мирное решение.",
          nextStage: "escalation",
          priority: "urgent",
        },
      },
      payment_confirmation: {
        positive: {
          text: "Отлично! Я зафиксирую договоренность об оплате. Реквизиты отправлю SMS. Жду подтверждения оплаты. Спасибо за сотрудничество!",
          nextStage: "completed",
          priority: "normal",
        },
        negative: {
          text: "Понимаю, что обстоятельства могут измениться. Какой реальный срок оплаты вы можете гарантировать?",
          nextStage: "payment_offer",
          priority: "high",
        },
      },
      escalation: {
        positive: {
          text: "Рад, что готовы к конструктивному диалогу. Давайте вернемся к обсуждению вариантов погашения.",
          nextStage: "payment_offer",
          priority: "normal",
        },
        negative: {
          text: "К сожалению, при отказе от сотрудничества дело будет передано в правовой отдел для судебного иска. Это последняя возможность урегулировать мирным путем.",
          nextStage: "legal_transfer",
          priority: "urgent",
        },
        aggressive: {
          text: "Прошу соблюдать этику общения. При продолжении неподобающего поведения разговор будет завершен. Последний раз предлагаю обсудить погашение.",
          nextStage: "final_attempt",
          priority: "urgent",
        },
        hang_up: {
          text: "До свидания.",
          nextStage: "completed",
          priority: "normal",
        },
      },
    };

    // Return script or fallback
    return (
      scripts[stage]?.[clientResponse] || {
        text: "Не совсем понял вашу реакцию. Можете повторить?",
        nextStage: stage,
        priority: "high",
      }
    );
  }

  static getRandomGreeting() {
    const greetings = [
      "Добрый день!",
      "Здравствуйте!",
      "Доброе утро!",
      "Добро пожаловать!",
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }
}
