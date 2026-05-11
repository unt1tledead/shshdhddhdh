import asyncio
import logging
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext
from aiogram.utils.keyboard import ReplyKeyboardBuilder

# Токен (Обнови его в BotFather!)
TOKEN = "7989747566:AAHjgk37pmPQpI8xbrjwE09WyoD1crRIQKo"

# Настройка состояний игры
class HackerGame(StatesGroup):
    s1 = State()   # Вход
    s2 = State()   # Логи
    s3 = State()   # IP
    s4 = State()   # БД Провайдера
    s5 = State()   # Данные владельца
    s6 = State()   # Соцсети
    s7 = State()   # Модель телефона
    s8 = State()   # Метаданные фото
    s9 = State()   # Координаты
    s10 = State()  # Финал

bot = Bot(token=TOKEN)
dp = Dispatcher()

# Клавиатура с командами
def get_hacker_kb():
    builder = ReplyKeyboardBuilder()
    commands = [
        "🔑 BRUTE_FORCE", "📂 VIEW_LOGS", "📡 WHOIS_IP", 
        "💉 SQL_INJECTION", "📊 EXTRACT_DATA", "🌐 SEARCH_SOCIAL", 
        "🖼 GET_METADATA", "📍 DECRYPT_GPS", "📸 ACCESS_WEBCAM", "🔄 RESET"
    ]
    for cmd in commands:
        builder.button(text=cmd)
    builder.adjust(2)
    return builder.as_markup(resize_keyboard=True)

# Начало игры
@dp.message(Command("start"))
async def cmd_start(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s1)
    await message.answer(
        "💻 **TERMINAL v.1.21**\n"
        "--------------------------\n"
        "Цель: Хакинг и OSINT-расследование.\n"
        "Объект: 'Black_Hat_Admin'.\n"
        "Задача: Получить доступ к входному шлюзу сервера.",
        reply_markup=get_hacker_kb()
    )

# Обработка шагов
@dp.message(HackerGame.s1, F.text == "🔑 BRUTE_FORCE")
async def step1(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s2)
    await message.answer("✅ Подбор пароля завершен. Доступ к системе открыт. Нужно просмотреть логи соединений.")

@dp.message(HackerGame.s2, F.text == "📂 VIEW_LOGS")
async def step2(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s3)
    await message.answer("📝 В логах найден подозрительный IP: `95.165.12.33` (Майкоп). Проверь владельца через базу.")

@dp.message(HackerGame.s3, F.text == "📡 WHOIS_IP")
async def step3(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s4)
    await message.answer("📍 Провайдер: 'RT-Line'. Чтобы узнать точный адрес, нужно взломать их базу данных.")

@dp.message(HackerGame.s4, F.text == "💉 SQL_INJECTION")
async def step4(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s5)
    await message.answer("🔓 База провайдера взломана! Доступна выгрузка по IP. Извлеки данные владельца.")

@dp.message(HackerGame.s5, F.text == "📊 EXTRACT_DATA")
async def step5(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s6)
    await message.answer("👤 Данные: Иванов А.В., 2004 г.р. Теперь найдем его след в сети.")

@dp.message(HackerGame.s6, F.text == "🌐 SEARCH_SOCIAL")
async def step6(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s7)
    await message.answer("🔗 Найден аккаунт в VK и фото в Instagram. Нужно проанализировать последнее загруженное фото.")

@dp.message(HackerGame.s7, F.text == "🖼 GET_METADATA")
async def step7(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s8)
    await message.answer("🔍 В фото найдены скрытые EXIF-данные. Нужно расшифровать GPS-теги.")

@dp.message(HackerGame.s8, F.text == "📍 DECRYPT_GPS")
async def step8(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s9)
    await message.answer("📍 Координаты: 44.6088, 40.1058. Это жилой дом! Нужно подтверждение личности.")

@dp.message(HackerGame.s9, F.text == "📸 ACCESS_WEBCAM")
async def step9(message: types.Message, state: FSMContext):
    await state.set_state(HackerGame.s10)
    await message.answer(
        "🔴 СОЕДИНЕНИЕ УСТАНОВЛЕНО...\n"
        "Вы видите комнату цели через веб-камеру ноутбука. Личность подтверждена.\n"
        "Поздравляю, хакер! Цель обнаружена. Игра завершена.",
        reply_markup=get_hacker_kb()
    )

# Сброс и ошибки
@dp.message(F.text == "🔄 RESET")
async def cmd_reset(message: types.Message, state: FSMContext):
    await state.clear()
    await cmd_start(message, state)

@dp.message(F.text)
async def wrong_action(message: types.Message):
    await message.answer("❌ Ошибка: Команда недоступна или нарушена последовательность взлома!")

async def main():
    logging.basicConfig(level=logging.INFO)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
