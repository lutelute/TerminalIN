// TiN 隔離テスト wrapper — REST Origin/Host 検証用
// 別 userData (orchApi:true をクラフト済み) + TIN_REST_PORT で起動し、
// scripts/test-rest-origin.sh が curl で叩いて検証する。終了はスクリプト側の kill。
const path = require('path');
const { app } = require('electron');

const TESTDATA = path.join(__dirname, '.tin-test-userdata-rest');
app.setPath('userData', TESTDATA);

require(path.join(__dirname, 'main.js'));
