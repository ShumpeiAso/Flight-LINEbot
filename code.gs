// =====================
// 環境変数・グローバル定数
// =====================
const LINE_ACCESS_TOKEN = "ラインのアクセストークン";
const AVIATION_EDGE_KEY = "アビエーションエッジのAPI key";
const SPREADSHEET_ID = "スプレッドシートＩＤ"; // スプレッドシートURLの「/d/〇〇〇/edit」の〇〇〇の部分

// ==========================================
// LINEからのWebhookを受け取るメイン関数
// ==========================================
function doPost(e) {
  try {
    const json = JSON.parse(e.postData.contents);
    const event = json.events[0];
    if (!event) return;
    
    const replyToken = event.replyToken;
    const userId = event.source.userId;
    const cache = CacheService.getScriptCache(); 

    // ==========================================
    // ① 友だち追加（またはブロック解除）された場合
    // ==========================================
    if (event.type === 'follow') {
      sendLineReply(replyToken, [{
        type: "text",
        text: "友だち追加ありがとう！\n\n便名（例: JL319）を送るだけで検索できます！\n下のボタンからの登録や確認もしてみてね！"
      }]);
      return;
    }

    // ==========================================
    // ② テキストメッセージを受け取った場合
    // ==========================================
    if (event.type === 'message' && event.message.type === 'text') {
      const userText = event.message.text.trim(); 
      const args = userText.split(/[\s]+/); 

      // 登録一覧の確認
      if (userText === "登録一覧") {
        cache.remove('user_state_' + userId); 
        sendUserFlightList(userId, replyToken);
        return;
      }

      // 登録削除の開始
      if (userText === "登録削除") {
        cache.remove('user_state_' + userId);
        promptDeleteFlight(userId, replyToken);
        return;
      }
      
      // 登録コマンドの判定（手打ちテキスト用）
      if (args[0] === "登録" && args.length >= 3) {
        cache.remove('user_state_' + userId); 
        const rawFlight = args[1].toUpperCase();
        const rawDate = args[2];
        
        const parsedDate = new Date(rawDate);
        if (isNaN(parsedDate.getTime())) {
          sendLineReply(replyToken, [{ type: "text", text: "日付は「2026/07/20」のように入力してください！" }]);
          return;
        }
        const formattedDate = Utilities.formatDate(parsedDate, "Asia/Tokyo", "yyyy/MM/dd");
        const flightNumber = parseFlightNumberFromInput(rawFlight);
        
        if (!flightNumber) {
          sendLineReply(replyToken, [{ type: "text", text: "航空便を特定できませんでした。もう一度入力し直してください。" }]);
          return;
        }

        processRegistration(userId, replyToken, flightNumber, formattedDate, rawFlight);
        return;
      }

      // キャッシュ状態の確認（「日付選択」の続きかどうか）
      const stateRaw = cache.get('user_state_' + userId);
      if (stateRaw) {
        const state = JSON.parse(stateRaw);
        if (state.step === 'waiting_for_flight') {
          const rawFlight = userText.toUpperCase();
          const flightNumber = parseFlightNumberFromInput(rawFlight);

          if (!flightNumber) {
            sendLineReply(replyToken, [{ 
              type: "text", 
              text: "便名が正しくないみたいです。「JL123」や「MM289」のように入力してください！" 
            }]);
            return; 
          }

          cache.remove('user_state_' + userId);
          processRegistration(userId, replyToken, flightNumber, state.date, rawFlight);
          return;
        }
      }

      // 通常の一発検索（日付指定なし）
      const rawFlight = userText.toUpperCase();
      const flightNumber = parseFlightNumberFromInput(rawFlight);
      
      if (!flightNumber) {
        sendLineReply(replyToken, [{ 
          type: "text", 
          text: "航空便を特定できませんでした。「JL123」のように入力してください！"
        }]);
      } else {
        const flightData = fetchFlightRawData(flightNumber, null, rawFlight);
        if (!flightData) {
          sendLineReply(replyToken, [{ 
            type: "text", 
            text: `現在「${flightNumber}」の直近スケジュールが見つかりません。\n搭乗日が先の場合は、下の「📅 便を登録」から日付を選んで登録してください！`
          }]);
        } else {
          const replyMessages = buildFlexMessage(flightNumber, flightData);
          sendLineReply(replyToken, replyMessages);
        }
      }
    } 
    // ==========================================
    // 📅 ③ カレンダー・ボタン（Postback）を受け取った場合
    // ==========================================
    else if (event.type === 'postback') {
      const postbackData = event.postback.data; 
      
      // 📅 便を登録するフローの開始
      if (postbackData === "action=start_register_flow") {
        const selectedDate = event.postback.params.date.replace(/-/g, "/"); 
        
        cache.put('user_state_' + userId, JSON.stringify({
          step: 'waiting_for_flight',
          date: selectedDate
        }), 600);

        sendLineReply(replyToken, [{ 
          type: "text", 
          text: `📅 搭乗日を「${selectedDate}」に設定しました！\n次に、登録したい便名（例: JL319）を送信してください！` 
        }]);
      }
      
      // カード内などの「この便を登録」ボタンから直接飛んできた場合
      else if (postbackData && postbackData.startsWith("action=register_from_search")) {
        const flightNumber = postbackData.split("flight=")[1];
        const selectedDate = event.postback.params.date.replace(/-/g, "/"); 
        processRegistration(userId, replyToken, flightNumber, selectedDate, flightNumber);
      }
      
      // フライトの削除処理
      else if (postbackData && postbackData.startsWith("action=delete_flight")) {
        const parts = postbackData.split("&");
        let delFlight = "", delDate = "";
        for (let p of parts) {
          if (p.startsWith("flight=")) delFlight = p.split("=")[1];
          if (p.startsWith("date=")) delDate = p.split("=")[1].replace(/-/g, "/");
        }

        const isDeleted = deleteUserFlight(userId, delFlight, delDate);
        if (isDeleted) {
          sendLineReply(replyToken, [{ 
            type: "text", 
            text: `✅ ${delDate} の「${delFlight}」の登録を解除したバイ！` 
          }]);
        } else {
          sendLineReply(replyToken, [{ 
            type: "text", 
            text: `エラーが発生しました。` 
          }]);
        }
      }
    }
  } catch (error) {
    console.error("Error in doPost: " + error.toString());
  }
}

// ==========================================
// 登録処理をまとめたヘルパー関数
// ==========================================
function processRegistration(userId, replyToken, flightNumber, selectedDate, rawFlight) {
  const flightData = fetchFlightRawData(flightNumber, selectedDate, rawFlight);
  
  if (!flightData) {
    saveUserFlight(userId, flightNumber, selectedDate, null);
    sendLineReply(replyToken, [{ 
      type: "text", 
      text: `「${flightNumber}」の運航スケジュールが、今はまだAPIに反映されてません。`
    }]);
    return;
  } 
  
  const eqCode = saveUserFlight(userId, flightNumber, selectedDate, flightData);
  const schedOut = flightData.departure?.estimatedTime || flightData.departure?.scheduledTime;
  const schedIn  = flightData.arrival?.estimatedTime   || flightData.arrival?.scheduledTime;

  if (!schedOut && !schedIn) {
    sendLineReply(replyToken, [{ 
      type: "text", 
      text: `✅ 「${flightNumber}」を ${selectedDate} で登録しました！\n\n搭乗日が近づいたら自動で時刻を通知します！` 
    }]);
    return;
  }

  try {
    const replyMessages = buildFlexMessage(flightNumber, flightData, eqCode);
    replyMessages.unshift({ 
      type: "text", 
      text: `✅ 「${flightNumber}」を ${selectedDate} で登録しました！\n搭乗3時間前と、その後の遅延・ゲート変更も自動でお知らせします`
    });
    sendLineReply(replyToken, replyMessages);
  } catch (e) {
    sendLineReply(replyToken, [{ 
      type: "text", 
      text: `✅ 「${flightNumber}」を ${selectedDate} で登録したよ！搭乗3時間前から自動でお知らせします！`
    }]);
  }
}

// ==========================================
// 共通クイックリプライ付きメッセージ作成
// ==========================================
function attachDefaultQuickReply(messages) {
  let msgArray = Array.isArray(messages) ? messages : [messages];
  const lastIndex = msgArray.length - 1;
  
  if (!msgArray[lastIndex].quickReply) {
    msgArray[lastIndex].quickReply = {
      items: [
        {
          type: "action",
          action: {
            type: "message",
            label: "📋 登録一覧",
            text: "登録一覧"
          }
        },
        {
          type: "action",
          action: {
            type: "datetimepicker",
            label: "📅 便を登録",
            data: "action=start_register_flow",
            mode: "date"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "❌ 登録削除",
            text: "登録削除"
          }
        }
      ]
    };
  }

  return msgArray;
}

// ==========================================
// ユーザーの登録便一覧を返す関数
// ==========================================
function sendUserFlightList(userId, replyToken) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  let flightList = [];
  const todayMs = new Date().setHours(0,0,0,0);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const flightNum = data[i][1];
      const rawDate = data[i][2];
      
      let dateObj = new Date(rawDate);
      if (dateObj.getTime() >= todayMs) {
        const dateStr = Utilities.formatDate(dateObj, "Asia/Tokyo", "yyyy/MM/dd");
        flightList.push(`・${dateStr}：${flightNum}便`);
      }
    }
  }

  let replyText = "";
  if (flightList.length === 0) {
    replyText = "今登録されてるこれからのフライトはみつかりません！";
  } else {
    replyText = "📝 【登録済みのフライト一覧】\n" + flightList.join("\n") + "\n\n搭乗日が近づいたら案内します！";
  }

  sendLineReply(replyToken, [{ type: "text", text: replyText }]);
}

// ==========================================
// 登録解除の候補一覧（クイックリプライ）を生成する関数
// ==========================================
function promptDeleteFlight(userId, replyToken) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  let items = [];
  const todayMs = new Date().setHours(0,0,0,0);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userId) {
      const flightNum = data[i][1];
      const rawDate = data[i][2];
      
      let dateObj = new Date(rawDate);
      if (dateObj.getTime() >= todayMs) {
        const dateStrHyphen = Utilities.formatDate(dateObj, "Asia/Tokyo", "yyyy-MM-dd");
        const dateStrDisp = Utilities.formatDate(dateObj, "Asia/Tokyo", "MM/dd");
        
        items.push({
          type: "action",
          action: {
            type: "postback",
            label: `❌ ${dateStrDisp} ${flightNum}便`,
            data: `action=delete_flight&flight=${flightNum}&date=${dateStrHyphen}`,
            displayText: `${dateStrDisp}の${flightNum}便を削除するバイ`
          }
        });
      }
    }
  }

  if (items.length === 0) {
    sendLineReply(replyToken, [{ type: "text", text: "削除できるこれからのフライトはありません！" }]);
    return;
  }

  if (items.length > 13) items = items.slice(0, 13);

  sendLineReply(replyToken, [{
    type: "text",
    text: "どのフライトの登録を解除しますか？\n下のボタンから選んでください！",
    quickReply: { items: items }
  }]);
}

// ==========================================
// ❌ 実際にスプレッドシートから行を削除する関数
// ==========================================
function deleteUserFlight(userId, flightNumber, dateStr) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return false;

  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    let rowDateStr = String(data[i][2]);
    if (data[i][2] instanceof Date) {
      rowDateStr = Utilities.formatDate(data[i][2], "Asia/Tokyo", "yyyy/MM/dd");
    }
    
    if (data[i][0] === userId && data[i][1] === flightNumber && rowDateStr === dateStr) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// ==========================================
// 💾 スプレッドシートへの保存処理（DBキャッシュ化）
// ==========================================
function saveUserFlight(userId, flightNumber, flightDate, flightData, skipReset = false) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return "-";
  
  let depTimeStr = "", arrTimeStr = "", depTerm = "", depGate = "", arrTerm = "", arrGate = "";
  let eqCode = "-";

  if (flightData) {
    const originTz = getAirportTimezone(flightData.departure?.iataCode);
    const destTz = getAirportTimezone(flightData.arrival?.iataCode);

    // 💡 修正①：常に estimatedTime を優先し、「最新の予定時刻」を基準としてDBに保存する
    const schedOut = flightData.departure?.estimatedTime || flightData.departure?.scheduledTime;
    if (schedOut) {
      const outMs = getAbsoluteTime(schedOut, originTz);
      if (outMs) depTimeStr = new Date(outMs).toISOString(); 
    }

    const schedIn = flightData.arrival?.estimatedTime || flightData.arrival?.scheduledTime;
    if (schedIn) {
      const inMs = getAbsoluteTime(schedIn, destTz);
      if (inMs) arrTimeStr = new Date(inMs).toISOString();
    }

    depTerm = flightData.departure?.terminal || "";
    depGate = flightData.departure?.gate || "";
    arrTerm = flightData.arrival?.terminal || "";
    arrGate = flightData.arrival?.gate || "";
    
    eqCode = extractEquipmentCode(flightData);
  }

  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  
  for (let i = 1; i < data.length; i++) {
    const sheetUserId = data[i][0];
    const sheetFlightNumber = data[i][1];
    let sheetDateStr = String(data[i][2]);
    if (data[i][2] instanceof Date) {
      sheetDateStr = Utilities.formatDate(data[i][2], "Asia/Tokyo", "yyyy/MM/dd");
    }

    if (sheetUserId === userId && sheetFlightNumber === flightNumber && sheetDateStr === flightDate) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const now = new Date(); 
  
  if (rowIndex > 0) {
    if (eqCode === "-" || eqCode === "") {
      const existingEq = sheet.getRange(rowIndex, 12).getValue();
      if (existingEq) eqCode = existingEq;
    }

    sheet.getRange(rowIndex, 4).setValue(depTimeStr);
    sheet.getRange(rowIndex, 5).setValue(arrTimeStr);
    sheet.getRange(rowIndex, 6).setValue(depTerm);   
    sheet.getRange(rowIndex, 7).setValue(depGate);   
    sheet.getRange(rowIndex, 8).setValue(arrTerm);   
    sheet.getRange(rowIndex, 9).setValue(arrGate);   
    sheet.getRange(rowIndex, 10).setValue(now);      
    
    if (!skipReset) {
      sheet.getRange(rowIndex, 11).setValue(false);  
    }
    sheet.getRange(rowIndex, 12).setValue(eqCode);   
  } else {
    sheet.appendRow([
      userId, flightNumber, flightDate, 
      depTimeStr, arrTimeStr, depTerm, depGate, arrTerm, arrGate, 
      now, false, eqCode
    ]);
  }
  
  return eqCode;
}

// ==========================================
// ⏰ 3時間前通知（チェック開始のトリガー）
// ==========================================
function checkAndNotifyPreFlight() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return;
  
  const data = sheet.getDataRange().getValues();
  const nowMs = Date.now();
  const threeHoursMs = 3 * 60 * 60 * 1000;       

  for (let i = 1; i < data.length; i++) {
    const userId = data[i][0];              
    const flightNumber = data[i][1];        
    const rawFlightDate = data[i][2];       
    const departureTimeRaw = data[i][3];    
    const preFlightNotified = data[i][10];  
    const cachedEq = data[i][11] || "-";    
    
    if (preFlightNotified === true || preFlightNotified === "true" || preFlightNotified === "departed" || !userId) continue;

    const regDateObj = new Date(rawFlightDate);
    if (isNaN(regDateObj.getTime())) continue;
    const regDateStr = Utilities.formatDate(regDateObj, "Asia/Tokyo", "yyyy/MM/dd");

    let departureMs = null;

    if (departureTimeRaw) {
      departureMs = new Date(departureTimeRaw).getTime();
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0); 
      const targetDateForCheck = new Date(regDateObj);
      targetDateForCheck.setHours(0, 0, 0, 0);
      const diffDays = Math.floor((targetDateForCheck.getTime() - today.getTime()) / 86400000);
      
      if (diffDays > 2) continue;

      const initFlightData = fetchFlightRawData(flightNumber, regDateStr);
      if (initFlightData) {
        saveUserFlight(userId, flightNumber, regDateStr, initFlightData);
        const originTz = getAirportTimezone(initFlightData.departure?.iataCode);
        const schedOut = initFlightData.departure?.estimatedTime || initFlightData.departure?.scheduledTime;
        if (schedOut) departureMs = getAbsoluteTime(schedOut, originTz);
      }
    }

    if (!departureMs) continue;

    const timeDiff = departureMs - nowMs;

    if (timeDiff > 0 && timeDiff <= threeHoursMs) {
      try {
        const latestFlightData = fetchFlightRawData(flightNumber, regDateStr);
        if (!latestFlightData) continue;

        const latestEq = saveUserFlight(userId, flightNumber, regDateStr, latestFlightData, true);

        const pushMessages = buildFlexMessage(flightNumber, latestFlightData, latestEq);
        pushMessages.unshift({ 
          type: "text", 
          text: `⏰ まもなく搭乗3時間前です！\n登録された便（${flightNumber}）の最新運行状況をお知らせします。この後もゲートや遅延に変更があれば通知します！` 
        });
        
        sendLinePush(userId, pushMessages);
        sheet.getRange(i + 1, 11).setValue(true);
      } catch (e) {
        console.error("Push Notification Error: " + e.toString());
      }
    }
  }
}

// ==========================================
// 🔄 定期実行：出発前の段階的チェック＆差分通知
// ==========================================
function checkFlightChanges() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName("user_flights");
  if (!sheet) return;
  
  const data = sheet.getDataRange().getValues();
  const nowMs = Date.now();

  for (let i = 1; i < data.length; i++) {
    const userId = data[i][0];
    const flightNumber = data[i][1];
    const rawFlightDate = data[i][2]; 
    const prevDepTimeRaw = data[i][3];   
    const prevDepGate = String(data[i][6] || "").trim(); 
    const lastUpdateRaw = data[i][9];    
    const preFlightNotified = data[i][10]; 
    
    if (preFlightNotified === "departed") continue;
    if (!prevDepTimeRaw || !lastUpdateRaw) continue;
    
    const departureMs = new Date(prevDepTimeRaw).getTime();
    const lastUpdateMs = new Date(lastUpdateRaw).getTime();
    const timeToDep = departureMs - nowMs; 
    
    if (timeToDep > 24 * 60 * 60 * 1000) continue;

    if (timeToDep < -(1 * 60 * 60 * 1000)) {
       sheet.getRange(i + 1, 11).setValue("departed"); 
       continue;
    }

    let shouldCheck = false;
    
    if (timeToDep <= 0) {
      if (nowMs - lastUpdateMs >= 15 * 60 * 1000) shouldCheck = true;
    } else if (timeToDep <= 1 * 60 * 60 * 1000) { 
      if (nowMs - lastUpdateMs >= 10 * 60 * 1000) shouldCheck = true;
    } else if (timeToDep <= 3 * 60 * 60 * 1000) { 
      if (nowMs - lastUpdateMs >= 25 * 60 * 1000) shouldCheck = true;
    } else if (timeToDep <= 24 * 60 * 60 * 1000) {
      if (nowMs - lastUpdateMs >= 60 * 60 * 1000) shouldCheck = true;
    }
    
    if (!shouldCheck) continue;

    const regDateObj = new Date(rawFlightDate);
    if (isNaN(regDateObj.getTime())) continue;
    const regDateStr = Utilities.formatDate(regDateObj, "Asia/Tokyo", "yyyy/MM/dd");

    const latestData = fetchFlightRawData(flightNumber, regDateStr);
    if (!latestData) continue;

    const actualOut = latestData.departure?.actualTime;
    const status = latestData.status ? latestData.status.toLowerCase() : "";
    if (actualOut || status === "active" || status === "landed" || status === "diverted" || status === "cancelled" || status === "canceled") {
        saveUserFlight(userId, flightNumber, regDateStr, latestData, true);
        sheet.getRange(i + 1, 11).setValue("departed");
        continue;
    }

    const newDepGate = String(latestData.departure?.gate || "-").trim();
    const newDepTimeRawStr = latestData.departure?.estimatedTime || latestData.departure?.scheduledTime;
    
    const originTz = getAirportTimezone(latestData.departure?.iataCode);
    let newDepMs = departureMs;
    if (newDepTimeRawStr) {
      newDepMs = getAbsoluteTime(newDepTimeRawStr, originTz) || departureMs;
    }

    let changeMessages = [];

    const isOldGateEmpty = prevDepGate === "-" || prevDepGate === "";
    const isNewGateEmpty = newDepGate === "-" || newDepGate === "";
    
    if (prevDepGate !== newDepGate && !isNewGateEmpty) {
      if (isOldGateEmpty) {
        changeMessages.push(`🚪 **搭乗ゲートが決定しました！**\n👉 【 ${newDepGate} 】ゲートに向かってください！`);
      } else {
        changeMessages.push(`🚪 **搭乗ゲート変更**\n【変更前】${prevDepGate} ゲート\n【変更後】👉 **${newDepGate} ゲート**`);
      }
    }

    const diffMins = Math.round((newDepMs - departureMs) / 60000);
    if (Math.abs(diffMins) >= 5) {
      const oldTimeStr = Utilities.formatDate(new Date(departureMs), originTz, "HH:mm");
      const newTimeStr = Utilities.formatDate(new Date(newDepMs), originTz, "HH:mm");
      
      if (oldTimeStr !== newTimeStr) {
        changeMessages.push(`⏰ **出発時刻変更**\n【変更前】${oldTimeStr} (現地時間)\n【変更後】👉 **${newTimeStr}**`);
      }
    }

    const latestEq = saveUserFlight(userId, flightNumber, regDateStr, latestData, true);

    if (changeMessages.length > 0 && (preFlightNotified === true || preFlightNotified === "true")) {
      const pushText = `⚠️ 【${flightNumber}便】運航情報に変更がありました！\n\n` + 
                       changeMessages.join("\n\n") + 
                       `\n\n空港の案内板もあわせて確認してください！`;
      
      const pushMessages = buildFlexMessage(flightNumber, latestData, latestEq);
      pushMessages.unshift({ type: "text", text: pushText });

      sendLinePush(userId, pushMessages);
    }
  }
}

// ==========================================
// 🌐 Aviation Edge からフライト生データを取得
// ==========================================
function fetchFlightRawData(flightNumber, targetDateStr = null, userRawInput = "") {
  const match = flightNumber.match(/^([A-Z]+)([0-9]+)$/);
  if (!match) return null;
  
  const airlineCode = match[1]; 
  const flightNum = match[2];   
  
  let code3 = airlineCode;
  let code2 = airlineCode;
  
  const rawMatch = userRawInput.match(/^([A-Z]+)([0-9]+)$/);
  if (rawMatch && rawMatch[1].length === 2) {
    code2 = rawMatch[1];
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "air_code_" + airlineCode;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    const parsed = JSON.parse(cached);
    code3 = parsed.code3;
    code2 = parsed.code2;
  } else {
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = ss.getSheetByName("airline_codes");
      if (sheet) {
        const data = sheet.getDataRange().getValues();
        for (let i = 1; i < data.length; i++) {
          const c3 = String(data[i][1]).toUpperCase().trim();
          const c2 = String(data[i][2]).toUpperCase().trim();
          if (airlineCode === c3 || airlineCode === c2) {
            code3 = c3;
            code2 = c2;
            cache.put(cacheKey, JSON.stringify({ code3: c3, code2: c2 }), 21600);
            break;
          }
        }
      }
    } catch(e) {}
  }

  const ttIcaoParam = `flight_icao=${code3}${flightNum}`; 
  const ttIataParam = `flight_iata=${code2}${flightNum}`; 
  const trIcaoParam = `flightIcao=${code3}${flightNum}`; 
  const trIataParam = `flightIata=${code2}${flightNum}`; 
  const futIcaoParam = `flight_icao=${code3}${flightNum}`;
  const futIataParam = `flight_iata=${code2}${flightNum}`;

  Logger.log(`[START] 検索開始: 便名=${flightNumber} (ICAO:${code3} / IATA:${code2}), 日付=${targetDateStr}`);

  let diffDays = 0;
  if (targetDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const parts = targetDateStr.split("/");
    const targetDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    targetDate.setHours(0, 0, 0, 0);
    diffDays = Math.floor((targetDate.getTime() - today.getTime()) / 86400000);
  }

  const getDepartureIata = () => {
    let ref = fetchFromTimetable(ttIataParam, null);
    if (!ref) ref = fetchFromTimetable(ttIcaoParam, null);
    if (!ref) ref = fetchFromTracker(trIataParam, null);
    if (!ref) ref = fetchFromTracker(trIcaoParam, null);
    if (ref && ref.departure && ref.departure.iataCode) return ref.departure.iataCode;

    Logger.log("⚠️ 直近実績にないため、Routes APIで路線マスタを検索します...");
    const routesUrlIata = `https://aviation-edge.com/v2/public/routes?key=${AVIATION_EDGE_KEY}&flightIata=${code2}${flightNum}`;
    const routesUrlIcao = `https://aviation-edge.com/v2/public/routes?key=${AVIATION_EDGE_KEY}&flightIcao=${code3}${flightNum}`;
    
    try {
      let routeRes = UrlFetchApp.fetch(routesUrlIata, { method: "get", muteHttpExceptions: true });
      if (routeRes.getResponseCode() !== 200 && code3 !== code2) {
         routeRes = UrlFetchApp.fetch(routesUrlIcao, { method: "get", muteHttpExceptions: true });
      }
      if (routeRes.getResponseCode() === 200) {
        const routeData = JSON.parse(routeRes.getContentText());
        if (Array.isArray(routeData) && routeData.length > 0 && routeData[0].departureIata) {
          Logger.log(`✅ Routes APIから出発空港を発見: ${routeData[0].departureIata}`);
          return routeData[0].departureIata;
        }
      }
    } catch (e) {
      Logger.log("Routes API Error: " + e.toString());
    }
    return null;
  };

  let flightData = null;

  if (targetDateStr && diffDays >= 8) {
    Logger.log("➡️ [8日以上先] Future API要求に必要な出発空港を特定します...");
    const depIata = getDepartureIata();
    if (depIata) {
      Logger.log("CALL: Future (IATA) -> " + futIataParam + ` & iataCode=${depIata}`);
      flightData = fetchFromFutureSchedules(futIataParam, targetDateStr, depIata);
      
      if (!flightData && code3 !== code2) {
        Logger.log("CALL: Future (ICAO) -> " + futIcaoParam + ` & iataCode=${depIata}`);
        flightData = fetchFromFutureSchedules(futIcaoParam, targetDateStr, depIata);
      }
    } else {
      Logger.log("❌ 出発空港を特定できなかったため、Future APIの呼び出しをスキップします");
    }
    return flightData;
  }

  Logger.log("CALL: Timetable (IATA) -> " + ttIataParam);
  flightData = fetchFromTimetable(ttIataParam, targetDateStr);

  if (!flightData && code3 !== code2) {
    Logger.log("CALL: Timetable (ICAO) -> " + ttIcaoParam);
    flightData = fetchFromTimetable(ttIcaoParam, targetDateStr);
  }

  if (!flightData) {
    Logger.log("CALL: Tracker (IATA) -> " + trIataParam);
    flightData = fetchFromTracker(trIataParam, targetDateStr);
  }

  if (!flightData && code3 !== code2) {
    Logger.log("CALL: Tracker (ICAO) -> " + trIcaoParam);
    flightData = fetchFromTracker(trIcaoParam, targetDateStr);
  }

  if (!flightData && targetDateStr) {
    Logger.log("⚠️ フォールバック: Future API要求に必要な出発空港を特定します...");
    const depIata = getDepartureIata();
    if (depIata) {
      Logger.log("CALL: Future (IATA) -> " + futIataParam + ` & iataCode=${depIata}`);
      flightData = fetchFromFutureSchedules(futIataParam, targetDateStr, depIata);

      if (!flightData && code3 !== code2) {
        Logger.log("CALL: Future (ICAO) -> " + futIcaoParam + ` & iataCode=${depIata}`);
        flightData = fetchFromFutureSchedules(futIcaoParam, targetDateStr, depIata);
      }
    } else {
      Logger.log("❌ 出発空港を特定できなかったため、Future APIの呼び出しをスキップします");
    }
  }

  Logger.log(flightData ? "✅ フライトデータ取得成功" : "❌ 全APIで該当データなし");
  return flightData;
}

// ⏱️ Timetable API 取得処理
function fetchFromTimetable(queryParam, targetDateStr) {
  const url = `https://aviation-edge.com/v2/public/timetable?key=${AVIATION_EDGE_KEY}&${queryParam}`;
  try {
    const response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
    
    // ★ デバッグ用ログ追加（ここでAPI制限が掛かっているか丸わかりになるバイ！）
    Logger.log("【Timetable API レスポンス】 ステータス:" + response.getResponseCode() + " 中身:" + response.getContentText().substring(0, 100) + "...");
    
    if (response.getResponseCode() !== 200) return null;
    
    const data = JSON.parse(response.getContentText());
    if (data.error || !Array.isArray(data) || data.length === 0) return null;

    if (!targetDateStr) {
      const nowMs = Date.now();
      let closestFlight = null;
      let minDiff = Infinity;

      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        const timeStr = item.departure?.scheduledTime || item.departure?.estimatedTime;
        if (!timeStr) continue;

        const tz = getAirportTimezone(item.departure?.iataCode);
        const flightMs = getAbsoluteTime(timeStr, tz);
        
        if (flightMs) {
          const diff = flightMs - nowMs;
          if (diff > -(3 * 60 * 60 * 1000) && diff < minDiff) {
            minDiff = diff;
            closestFlight = item;
          }
        }
      }
      if (closestFlight) return closestFlight;
      const activeFlight = data.find(f => f.status === "active");
      return activeFlight ? activeFlight : data[0];
    }

    const targetDateHyphen = targetDateStr.replace(/\//g, "-"); 

    for (let i = 0; i < data.length; i++) {
      let timeStr = (data[i].departure && data[i].departure.scheduledTime) || (data[i].departure && data[i].departure.estimatedTime);
      if (timeStr && timeStr.startsWith(targetDateHyphen)) {
        return data[i]; 
      }
    }
    return null; 
  } catch (e) {
    return null;
  }
}

// 🛰️ Live Tracker API 取得処理
function fetchFromTracker(queryParam, targetDateStr) {
  const url = `https://aviation-edge.com/v2/public/flights?key=${AVIATION_EDGE_KEY}&${queryParam}`;
  try {
    const response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
    
    // ★ デバッグ用ログ追加
    Logger.log("【Tracker API レスポンス】 ステータス:" + response.getResponseCode() + " 中身:" + response.getContentText().substring(0, 100) + "...");

    if (response.getResponseCode() !== 200) return null;
    
    const data = JSON.parse(response.getContentText());
    if (data.error || !Array.isArray(data) || data.length === 0) return null;

    let item = null;

    if (targetDateStr) {
      const targetDateHyphen = targetDateStr.replace(/\//g, "-");
      for (let i = 0; i < data.length; i++) {
        let timeStr = (data[i].departure && data[i].departure.scheduledTime);
        if (timeStr && timeStr.startsWith(targetDateHyphen)) {
          item = data[i];
          break;
        }
      }
      if (!item) return null; 
    } else {
      const nowMs = Date.now();
      let closestFlight = null;
      let minDiff = Infinity;
      
      for (let i = 0; i < data.length; i++) {
        let fItem = data[i];
        let timeStr = (fItem.departure && fItem.departure.scheduledTime);
        if (!timeStr) continue;
        
        const tz = getAirportTimezone(fItem.departure?.iataCode);
        const flightMs = getAbsoluteTime(timeStr, tz);
        
        if (flightMs) {
          const diff = flightMs - nowMs;
          if (diff > -(3 * 60 * 60 * 1000) && diff < minDiff) {
            minDiff = diff;
            closestFlight = fItem;
          }
        }
      }
      item = closestFlight ? closestFlight : data[0]; 
    }

    return {
      status: item.status || "active",
      airline: { name: item.airline ? (item.airline.name || item.airline.iataCode || item.airline.icaoCode) : "不明" },
      flight: { 
        iataEquipment: item.flight?.iataEquipment || item.aircraft?.iataCode || "-",
        icaoEquipment: item.flight?.icaoEquipment || item.aircraft?.icaoCode || "-"
      },
      aircraft: item.aircraft || null,
      departure: {
        iataCode: item.departure ? item.departure.iataCode : "",
        scheduledTime: item.departure ? item.departure.scheduledTime : null, 
        estimatedTime: item.departure ? item.departure.estimatedTime : null, // 💡 修正⑤: TrackerAPIからの握りつぶし防止
        actualTime: item.departure ? item.departure.actualTime : null,
        delay: item.departure ? item.departure.delay : 0,
        terminal: item.departure ? item.departure.terminal : "-",
        gate: item.departure ? item.departure.gate : "-"
      },
      arrival: {
        iataCode: item.arrival ? item.arrival.iataCode : "",
        scheduledTime: item.arrival ? item.arrival.scheduledTime : null,
        estimatedTime: item.arrival ? item.arrival.estimatedTime : null, // 💡 同上
        actualTime: item.arrival ? item.arrival.actualTime : null,
        delay: item.arrival ? item.arrival.delay : 0,
        terminal: item.arrival ? item.arrival.terminal : "-",
        gate: item.arrival ? item.arrival.gate : "-"
      }
    };
  } catch (e) {
    return null;
  }
}

// 📅 Future Schedules API 取得処理
function fetchFromFutureSchedules(queryParam, targetDateStr, depIata) {
  const targetDateHyphen = targetDateStr.replace(/\//g, "-");
  const url = `https://aviation-edge.com/v2/public/flightsFuture?key=${AVIATION_EDGE_KEY}&${queryParam}&date=${targetDateHyphen}&type=departure&iataCode=${depIata}`;
  
  try {
    const response = UrlFetchApp.fetch(url, { method: "get", muteHttpExceptions: true });
    
    // ★ デバッグ用ログ追加
    Logger.log("【Future API レスポンス】 ステータス:" + response.getResponseCode() + " 中身:" + response.getContentText().substring(0, 100) + "...");

    if (response.getResponseCode() !== 200) return null;
    
    const data = JSON.parse(response.getContentText());
    if (data.error || !Array.isArray(data) || data.length === 0) return null;

    const item = data[0];
    
    return {
      status: "scheduled",
      airline: { name: item.airline ? (item.airline.name || item.airline.iataCode || item.airline.icaoCode) : "不明" },
      flight: { 
        iataEquipment: item.flight ? item.flight.iataEquipment : "-",
        icaoEquipment: item.flight ? item.flight.icaoEquipment : "-"
      },
      aircraft: item.aircraft || null,
      departure: {
        iataCode: item.departure ? item.departure.iataCode : "",
        scheduledTime: item.departure ? item.departure.scheduledTime : null,
        // 💡 修正④: 将来的にAPIがestimatedを返した際に対応できるようマッピングを修正
        estimatedTime: item.departure ? (item.departure.estimatedTime || item.departure.scheduledTime) : null,
        terminal: item.departure ? item.departure.terminal : "-",
        gate: item.departure ? item.departure.gate : "-"
      },
      arrival: {
        iataCode: item.arrival ? item.arrival.iataCode : "",
        scheduledTime: item.arrival ? item.arrival.scheduledTime : null,
        estimatedTime: item.arrival ? (item.arrival.estimatedTime || item.arrival.scheduledTime) : null,
        terminal: item.arrival ? item.arrival.terminal : "-",
        gate: item.arrival ? item.arrival.gate : "-"
      }
    };
  } catch (e) {
    Logger.log("Exception: " + e.toString());
    return null;
  }
}

// ==========================================
// 🎨 LINE Flex メッセージを構築
// ==========================================
function buildFlexMessage(flightNumber, flight, cachedEq = "-") {
  let airlineName = (flight.airline && flight.airline.name) ? flight.airline.name : "不明な航空会社";
  const originCodeRaw = (flight.departure && flight.departure.iataCode) ? flight.departure.iataCode : "";
  const destCodeRaw   = (flight.arrival && flight.arrival.iataCode) ? flight.arrival.iataCode : "";
  
  const originData = getAirportData(originCodeRaw);
  const destData   = getAirportData(destCodeRaw);
  const originName = originData.name;
  const destName   = destData.name;
  const originCodeDisplay = originData.displayCode;
  const destCodeDisplay   = destData.displayCode;

  const originTz = getAirportTimezone(originCodeRaw);
  const destTz   = getAirportTimezone(destCodeRaw);

  const schedOutRaw = (flight.departure && flight.departure.scheduledTime) ? flight.departure.scheduledTime : null;
  const actualOutRaw = (flight.departure && flight.departure.actualTime) ? flight.departure.actualTime : null;
  const estimOutRaw = (flight.departure && flight.departure.estimatedTime) ? flight.departure.estimatedTime : actualOutRaw;
  
  let schedOutText = formatAeTime(schedOutRaw);
  let estimOutText = formatAeTime(estimOutRaw);
  if (schedOutText === "-" && estimOutText !== "-") schedOutText = estimOutText;
  if (estimOutText === "-" && schedOutText !== "-") estimOutText = schedOutText;

  const schedInRaw = (flight.arrival && flight.arrival.scheduledTime) ? flight.arrival.scheduledTime : null;
  const actualInRaw = (flight.arrival && flight.arrival.actualTime) ? flight.arrival.actualTime : null;
  const estimInRaw = (flight.arrival && flight.arrival.estimatedTime) ? flight.arrival.estimatedTime : actualInRaw;

  let schedInText = formatAeTime(schedInRaw);
  let estimInText = formatAeTime(estimInRaw);
  if (schedInText === "-" && estimInText !== "-") schedInText = estimInText;
  if (estimInText === "-" && schedInText !== "-") estimInText = schedInText;

  const originTerminal = (flight.departure && flight.departure.terminal) ? flight.departure.terminal : "-";
  const originGate     = (flight.departure && flight.departure.gate)     ? flight.departure.gate     : "-";
  const destTerminal   = (flight.arrival && flight.arrival.terminal)     ? flight.arrival.terminal   : "-";
  const destGate       = (flight.arrival && flight.arrival.gate)         ? flight.arrival.gate       : "-";

  let equipmentCode = extractEquipmentCode(flight);
  if ((equipmentCode === "-" || equipmentCode === "") && cachedEq !== "-") {
    equipmentCode = cachedEq;
  }
  const myAircraftFriendly = getAircraftName(equipmentCode);

  const nowMs = new Date().getTime();
  const originalOut = schedOutRaw || estimOutRaw; 
  const originalIn  = schedInRaw || estimInRaw;   
  const outMs = getAbsoluteTime(originalOut, originTz);

  let targetInMs = null;
  if (estimInRaw) targetInMs = getAbsoluteTime(estimInRaw, destTz);
  else if (schedInRaw) targetInMs = getAbsoluteTime(schedInRaw, destTz);

  let hasDeparted = false;
  if (actualOutRaw) {
    const aOutMs = getAbsoluteTime(actualOutRaw, originTz) || new Date(actualOutRaw).getTime();
    if (aOutMs <= nowMs) hasDeparted = true;
  }
  
  let hasArrived = false;
  if (actualInRaw) {
    const aInMs = getAbsoluteTime(actualInRaw, destTz) || new Date(actualInRaw).getTime();
    if (aInMs <= nowMs) hasArrived = true;
  }

  let outDelayMins = (flight.departure && flight.departure.delay) ? Number(flight.departure.delay) : 0;
  let inDelayMins  = (flight.arrival && flight.arrival.delay) ? Number(flight.arrival.delay) : 0;
  
  if (schedOutRaw && estimOutRaw) {
    const sOutMs = getAbsoluteTime(schedOutRaw, originTz);
    const eOutMs = getAbsoluteTime(estimOutRaw, originTz);
    if (sOutMs && eOutMs) outDelayMins = Math.round((eOutMs - sOutMs) / 60000);
  }
  if (schedInRaw && estimInRaw) {
    const sInMs = getAbsoluteTime(schedInRaw, destTz);
    const eInMs = getAbsoluteTime(estimInRaw, destTz);
    if (sInMs && eInMs) inDelayMins = Math.round((eInMs - sInMs) / 60000);
  }

  const isOutDelayed = outDelayMins >= 5; 
  const isInDelayed  = inDelayMins >= 5;  
  const isInEarly    = inDelayMins <= -5; 

  let rawStatus = flight.status ? flight.status.toLowerCase() : "";
  if (rawStatus === "active" && outMs && nowMs < outMs && !hasDeparted) rawStatus = "scheduled";

  let statusJp = "不明";
  let statusColor = "#9ca3af"; 

  if (rawStatus === "cancelled" || rawStatus === "canceled") {
    statusJp = "欠航"; statusColor = "#ef4444"; 
  } else if (rawStatus === "diverted" || rawStatus === "incident") {
    statusJp = "目的地変更/トラブル"; statusColor = "#a855f7"; 
  } else if (rawStatus === "landed" || hasArrived) {
    statusJp = isInDelayed ? "遅れて到着" : (isInEarly ? "早着" : "到着済み");
    statusColor = isInDelayed ? "#f97316" : "#22c55e"; 
  } else if (rawStatus === "active" || rawStatus === "en-route" || (hasDeparted && !hasArrived)) {
    if (targetInMs && nowMs >= targetInMs) {
      statusJp = "到着確認中"; statusColor = "#f59e0b"; 
    } else {
      statusJp = isInDelayed ? "遅延・フライト中" : (isInEarly ? "早着見込み・運行中" : "フライト中");
      statusColor = "#3b82f6"; 
    }
  } else { 
    statusJp = isInDelayed ? "遅延見込み" : (isInEarly ? "早着見込み" : "定刻 (予定)");
    statusColor = isInDelayed ? "#ef4444" : "#22c55e"; 
  }

  let flightDurationText = null;
  if (originalOut && originalIn) {
    const inMs = getAbsoluteTime(originalIn, destTz);
    if (outMs && inMs) {
      let diffMs = inMs - outMs;
      
      diffMs = diffMs % (24 * 60 * 60 * 1000);
      if (diffMs < 0) {
        diffMs += 24 * 60 * 60 * 1000;
      }
      
      if (diffMs > 0 && diffMs < 24 * 60 * 60 * 1000) {
        const diffMins = Math.floor(diffMs / 60000);
        flightDurationText = `${Math.floor(diffMins / 60)}時間${diffMins % 60}分`;
      }
    }
  }

  let flightDateText = "";
  if (originalOut) {
    const dMatch = originalOut.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dMatch) {
      flightDateText = `${dMatch[1]}年${dMatch[2]}月${dMatch[3]}日`;
    }
  }

  const titleBox = {
    "type": "box",
    "layout": "horizontal",
    "alignItems": "flex-end",
    "contents": [
      { "type": "text", "text": `✈️ ${flightNumber}`, "weight": "bold", "size": "xl", "color": "#111827", "flex": 0 }
    ]
  };

  if (flightDateText) {
    titleBox.contents.push({
      "type": "text",
      "text": `📅 ${flightDateText}`,
      "size": "sm",
      "color": "#6b7280",
      "weight": "bold",
      "align": "end",
      "gravity": "bottom",
      "flex": 1
    });
  }

  const bodyContents = [
    titleBox,
    { "type": "text", "text": airlineName, "size": "xs", "color": "#6b7280", "margin": "xs" },
    {
      "type": "box", "layout": "horizontal", "margin": "sm",
      "contents": [{
        "type": "box", "layout": "vertical", "backgroundColor": statusColor, "cornerRadius": "sm",
        "paddingStart": "md", "paddingEnd": "md", "paddingTop": "xs", "paddingBottom": "xs",
        "contents": [{ "type": "text", "text": statusJp, "color": "#ffffff", "size": "xxs", "weight": "bold" }]
      }]
    },
    { "type": "separator", "margin": "md" },
    {
      "type": "box", "layout": "horizontal", "margin": "md",
      "contents": [
        {
          "type": "box", "layout": "vertical", "flex": 5,
          "contents": [
            { "type": "text", "text": "DEPARTURE", "size": "xxs", "color": "#9ca3af", "weight": "bold" },
            { "type": "text", "text": originName, "weight": "bold", "size": "md", "color": "#111827", "wrap": true, "margin": "xs" },
            { "type": "text", "text": originCodeDisplay, "size": "xs", "color": "#4b5563", "margin": "xs" }
          ]
        },
        {
          "type": "box", "layout": "vertical", "flex": 1,
          "contents": [{ "type": "text", "text": "▶", "size": "sm", "color": "#9ca3af", "align": "center", "margin": "md" }]
        },
        {
          "type": "box", "layout": "vertical", "flex": 5,
          "contents": [
            { "type": "text", "text": "ARRIVAL", "size": "xxs", "color": "#9ca3af", "weight": "bold", "align": "end" },
            { "type": "text", "text": destName, "weight": "bold", "size": "md", "color": "#111827", "wrap": true, "align": "end", "margin": "xs" },
            { "type": "text", "text": destCodeDisplay, "size": "xs", "color": "#4b5563", "align": "end", "margin": "xs" }
          ]
        }
      ]
    }
  ];

  if (flightDurationText) {
    bodyContents.push({ "type": "text", "text": `⏱ 飛行時間: ${flightDurationText}`, "size": "xxs", "color": "#9ca3af", "align": "center", "margin": "md", "weight": "bold" });
  }

  const originBoxContents = [
    { "type": "text", "text": isOutDelayed ? "出発（遅延）" : "出発（定刻通り）", "size": "xxs", "color": "#9ca3af" },
    { "type": "text", "text": isOutDelayed ? estimOutText : schedOutText, "weight": "bold", "size": "sm", "color": isOutDelayed ? "#b91c1c" : "#16a34a" }
  ];
  if (isOutDelayed) originBoxContents.push({ "type": "text", "text": `定刻 ${schedOutText}`, "size": "xxs", "color": "#9ca3af" });
  originBoxContents.push(
    { "type": "text", "text": "ターミナル / ゲート", "size": "xxs", "color": "#9ca3af", "margin": "md" },
    { "type": "text", "text": `${originTerminal} / ${originGate}`, "weight": "bold", "size": "sm", "color": "#374151" }
  );

  const destBoxContents = [
    { "type": "text", "text": isInDelayed ? "到着（遅延）" : (isInEarly ? "到着（早着予定）" : "到着（定刻通り）"), "size": "xxs", "color": "#9ca3af", "align": "end" },
    { "type": "text", "text": (isInDelayed || isInEarly) ? estimInText : schedInText, "weight": "bold", "size": "sm", "color": isInDelayed ? "#b91c1c" : "#16a34a", "align": "end" }
  ];
  if (isInDelayed || isInEarly) destBoxContents.push({ "type": "text", "text": `定刻 ${schedInText}`, "size": "xxs", "color": "#9ca3af", "align": "end" });
  destBoxContents.push(
    { "type": "text", "text": "ターミナル / ゲート", "size": "xxs", "color": "#9ca3af", "margin": "md", "align": "end" },
    { "type": "text", "text": `${destTerminal} / ${destGate}`, "weight": "bold", "size": "sm", "color": "#374151", "align": "end" }
  );

  bodyContents.push(
    { "type": "separator", "margin": "md" },
    { "type": "box", "layout": "horizontal", "margin": "md", "contents": [
        { "type": "box", "layout": "vertical", "flex": 5, "contents": originBoxContents },
        { "type": "box", "layout": "vertical", "flex": 1, "contents": [] },
        { "type": "box", "layout": "vertical", "flex": 5, "contents": destBoxContents }
      ]
    },
    { "type": "separator", "margin": "md" },
    { "type": "box", "layout": "horizontal", "margin": "sm", "contents": [
        { "type": "text", "text": "⚙️ 運航機材:", "size": "xs", "color": "#4b5563" },
        { "type": "text", "text": myAircraftFriendly, "size": "xs", "weight": "bold", "color": "#1f2937", "align": "end", "wrap": true }
      ]
    }
  );

  return [{
    "type": "flex", "altText": `フライト状況: ${flightNumber}`,
    "contents": { 
      "type": "bubble", 
      "body": { "type": "box", "layout": "vertical", "contents": bodyContents },
      "footer": {
        "type": "box", "layout": "vertical", "spacing": "sm", "contents": [
          {
            "type": "button",
            "style": "primary",
            "color": "#22c55e",
            "height": "sm",
            "action": {
              "type": "datetimepicker",
              "label": "📅 この便を登録",
              "data": `action=register_from_search&flight=${flightNumber}`,
              "mode": "date"
            }
          },
          {
            "type": "button",
            "style": "primary",
            "color": "#0ea5e9",
            "height": "sm",
            "action": {
              "type": "uri",
              "label": "FlightAwareで運航状況を見る",
              "uri": `https://ja.flightaware.com/live/flight/${flightNumber}`
            }
          }
        ]
      }
    }
  }];
}

// ==========================================
// 📊 ユーザー入力を正規化して便名を抽出（API照会用）
// ==========================================
// 💡 修正⑥: 関数名を実態に合わせ変更。マスタ検索ではなく、APIに投げるための文字列の正規化処理です
function parseFlightNumberFromInput(userText) {
  const match = userText.match(/^([A-Z]+)\s*([0-9]+)$/);
  if (!match) return null;
  const inputCode = match[1];  
  const flightNum = parseInt(match[2], 10).toString();  
  
  return inputCode + flightNum; 
}

// ==========================================
// ✈️ 機材コードの抽出 (ヘルパー)
// ==========================================
function extractEquipmentCode(item) {
  if (!item) return "-";
  
  let code = "-";
  
  if (item.flight) {
    if (item.flight.iataEquipment && item.flight.iataEquipment !== "-") code = item.flight.iataEquipment;
    else if (item.flight.icaoEquipment && item.flight.icaoEquipment !== "-") code = item.flight.icaoEquipment;
  }
  
  if (code === "-" && item.aircraft) {
    if (item.aircraft.iataCode && item.aircraft.iataCode !== "-") code = item.aircraft.iataCode;
    else if (item.aircraft.icaoCode && item.aircraft.icaoCode !== "-") code = item.aircraft.icaoCode;
  }
  
  return code;
}

// ==========================================
// 📊 空港データの取得 (🗂️ キャッシュ対応)
// ==========================================
function getAirportData(code) {
  if (!code) return { name: "不明", displayCode: "不明" };
  const cleanCode = code.toUpperCase().trim();
  
  const cache = CacheService.getScriptCache();
  const cacheKey = "airport_" + cleanCode;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return JSON.parse(cachedData);
  
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const airportSheet = ss.getSheetByName("airport_codes");
  if (!airportSheet) return { name: code, displayCode: code }; 
  
  const data = airportSheet.getDataRange().getValues();
  let result = { name: code, displayCode: code };
  
  for (let i = 1; i < data.length; i++) {
    const airportName = String(data[i][2]);                      
    const iataCode    = String(data[i][3]).toUpperCase().trim(); 
    const icaoCode    = String(data[i][4]).toUpperCase().trim(); 
    
    if (cleanCode === iataCode || cleanCode === icaoCode) {
      let displayCode = cleanCode;
      if (iataCode && icaoCode) displayCode = `${iataCode} / ${icaoCode}`;
      else if (iataCode) displayCode = iataCode;
      else if (icaoCode) displayCode = icaoCode;
      
      result = { name: airportName, displayCode: displayCode };
      break;
    }
  }
  cache.put(cacheKey, JSON.stringify(result), 21600);
  return result; 
}

// ==========================================
// ✈️ 機材マスタの取得 (🗂️ キャッシュ対応)
// ==========================================
function getAircraftName(code) {
  if (!code || code === "-") return "情報なし";
  const cleanCode = code.toUpperCase().trim();
  
  const cache = CacheService.getScriptCache();
  const cacheKey = "aircraft_" + cleanCode;
  const cachedData = cache.get(cacheKey);
  if (cachedData) return cachedData;
  
  let result = cleanCode;
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName("aircraft_types");
    if (sheet) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const icaoCode = data[i][0] ? String(data[i][0]).toUpperCase().trim() : ""; 
        const iataCode = data[i][1] ? String(data[i][1]).toUpperCase().trim() : ""; 
        const description = data[i][2] ? String(data[i][2]).trim() : "";            
        
        if (cleanCode === icaoCode || cleanCode === iataCode) {
          result = description ? description : cleanCode;
          break;
        }
      }
    }
  } catch (e) {}
  cache.put(cacheKey, result, 21600);
  return result; 
}

// ==========================================
// 🌍 空港タイムゾーンの取得 (🗂️ キャッシュ対応)
// ==========================================
function getAirportTimezone(iataCode) {
  // 💡 修正⑦: 取得失敗時に Asia/Tokyo にフォールバックさせず、null を返す
  if (!iataCode) return null; 
  
  const cache = CacheService.getScriptCache();
  const cacheKey = "tz_" + iataCode;
  const cachedTz = cache.get(cacheKey);
  if (cachedTz) return cachedTz;
  
  const url = `https://aviation-edge.com/v2/public/airports?key=${AVIATION_EDGE_KEY}&iataCode=${iataCode}`;
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      if (Array.isArray(data) && data.length > 0 && data[0].timezone) {
        const tz = data[0].timezone;
        cache.put(cacheKey, tz, 21600); 
        return tz;
      }
    }
  } catch(e) {}
  return null; 
}

// ==========================================
// 🕒 時間文字列のフォーマット
// ==========================================
function formatAeTime(timeStr) {
  if (!timeStr) return "-";
  try {
    const parts = timeStr.split("T");
    if (parts.length === 2) {
      const datePart = parts[0].substring(5).replace(/-/g, "/"); 
      const timePart = parts[1].substring(0, 5); 
      return `${datePart} ${timePart}`;
    }
    return timeStr;
  } catch (e) {
    return "-";
  }
}

// ==========================================
// 🌍 絶対時間(Unix Timestamp)の算出
// ==========================================
function getAbsoluteTime(localIsoStr, timezone) {
  if (!localIsoStr) return null;
  try {
    const safeIsoStr = localIsoStr.replace(" ", "T");
    const timePart = safeIsoStr.substring(10);
    if (timePart.includes("+") || timePart.includes("-") || safeIsoStr.endsWith("Z")) {
      return new Date(safeIsoStr).getTime();
    }
    if (!timezone || timezone === "null" || timezone === "undefined") return null;

    const tempDate = new Date(safeIsoStr + "Z");
    const offsetStr = Utilities.formatDate(tempDate, timezone, "Z"); 
    const formattedOffset = offsetStr.substring(0, 3) + ":" + offsetStr.substring(3, 5); 
    
    const cleanLocal = safeIsoStr.split(".")[0].replace("Z", ""); 
    const exactIso = cleanLocal + formattedOffset; 
    return new Date(exactIso).getTime(); 
  } catch(e) {
    return null;
  }
}

// ==========================================
// ✉ LINEへメッセージを返信 / プッシュ
// ==========================================
function sendLineReply(replyToken, messagesArray) {
  const messagesWithQuickReply = attachDefaultQuickReply(messagesArray);

  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
    method: "post", contentType: "application/json",
    headers: { "Authorization": "Bearer " + LINE_ACCESS_TOKEN },
    payload: JSON.stringify({ replyToken: replyToken, messages: messagesWithQuickReply })
  });
}

function sendLinePush(userId, messagesArray) {
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post", contentType: "application/json",
    headers: { "Authorization": "Bearer " + LINE_ACCESS_TOKEN },
    payload: JSON.stringify({ to: userId, messages: messagesArray })
  });
}

// ==========================================
// 🧪 GASエディタ手動テスト用関数
// ==========================================
function testFlightFetch() {
  // ANA256便で今日の日付をテスト
  fetchFlightRawData("ANA256", "2026/08/21", "NH256");
}
