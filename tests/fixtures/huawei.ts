// Synthetic router pages in the exact format observed on an HN8546X6 (V5R020C00S287).
// Addresses use documentation ranges; serials and MACs are made up.

const x = (text: string) =>
  text.replace(/\./g, '\\x2e').replace(/:/g, '\\x3a').replace(/-/g, '\\x2d');

export const DEVICE_INFO_PAGE = `
<script>
function stDeviceInfo(domain,SerialNumber,HardwareVersion,SoftwareVersion,ModelName,VendorID,ReleaseTime,Mac,Description,ManufactureInfo,DeviceAlias) {}
var deviceInfo = new stDeviceInfo("InternetGatewayDevice.DeviceInfo","SERIAL-NOT-STORED","1CF0.E","V5R020C00S287","HN8546X6","HWTC","2021-09-29","aa:bb:cc:00:00:01","OptiXstar HN8546X6 XG-PON","FACTORY-NOT-STORED","");
var ontInfo = new ONTInfo("InternetGatewayDevice.X_HW_DEBUG.AMP.ONT","129","O5");
var dev_uptime = '94727';
var showCPUnMemUsed = '1';
var cpuUsed = '3%';
var memUsed = '39%';
</script>`;

export const OPTIC_PAGE = `
var opticInfos = new Array(new stOpticInfo("InternetGatewayDevice.X_HW_DEBUG.AMP.Optic","ok"," 3.59","-17.10","3376","52","26","--","--","HUAWEI          ","MODULE-SN-SECRET","210605","1310","1490","20","0"),null);`;

export const ETH_PAGE = `
var devInfo = new stDevInfo("InternetGatewayDevice.DeviceInfo","SERIAL","1","LOID-SECRET","EPON-PASSWORD-SECRET","HEX-SECRET");
var geInfos = new Array(new GEInfo("InternetGatewayDevice.X_HW_DEBUG.AMP.LANPort.1.CommonConfig","1","2","1"),new GEInfo("InternetGatewayDevice.X_HW_DEBUG.AMP.LANPort.2.CommonConfig","0","0","0"),null);
var lanStats = new Array(new LANStats("InternetGatewayDevice.X_HW_DEBUG.AMP.LANPort.1.Statistics","9600254","0","3656201063","1","0","0","6379331","0","3079905226","0","1613","0"),new LANStats("InternetGatewayDevice.X_HW_DEBUG.AMP.LANPort.2.Statistics","0","0","0","0","0","0","0","0","0","0","0","0"),null);`;

export const WLAN_PAGE = `
var WlanInfo = new Array(new stWlan("InternetGatewayDevice\\x2eLANDevice\\x2e1\\x2eWLANConfiguration\\x2e1","1","ath0","Home\\x20Net","11i","None","None","TKIPEncryption","PSKAuthentication","AESEncryption","PSKAuthentication","TKIPandAESEncryption","PSKAuthentication","7","InternetGatewayDevice.LANDevice.1.WiFi.Radio.1","11ax","RS","0","100","1","1","1","3","1"),new stWlan("InternetGatewayDevice\\x2eLANDevice\\x2e1\\x2eWLANConfiguration\\x2e2","0","ath1","Disabled","11i","None","None","","","","","","","7","","11ax","RS","0","100","1","1","1","0","1"),new stWlan("InternetGatewayDevice\\x2eLANDevice\\x2e1\\x2eWLANConfiguration\\x2e5","1","ath4","Home\\x20Net\\x205g","11i","None","None","","","","","","","36","InternetGatewayDevice.LANDevice.1.WiFi.Radio.2","11ax","RS","4","100","1","1","1","4","1"),null);
var packetInfo = new Array(new stPacketInfo("InternetGatewayDevice.LANDevice.1.WLANConfiguration.1","2869159692","8998465","261147131","1386994"),new stPacketInfo("InternetGatewayDevice.LANDevice.1.WLANConfiguration.5","1006711665","4455857","379309668","853896"),null);
var stats = new Array(new stStats("InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Stats","0","2","81756","0"),null);`;

export const WIFI_CLIENTS_PAGE = `
var AssociatedDevices = new Array(new stAssociatedDevice("InternetGatewayDevice\\x2eLANDevice\\x2e1\\x2eWLANConfiguration\\x2e5\\x2eAssociatedDevice\\x2e2","${x('AA:BB:CC:00:00:31')}","2223","68","195","-65","-91","26","29","11ax","4294967295","0","0","${x('192.168.100.31')}","iPhone","2*2","1","1","0","0"),null);`;

export const DEVICES_PAGE = `
var UserDevinfo = new Array(new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.1","${x('192.168.100.20')}","${x('aa:bb:cc:00:00:20')}","LAN1","DHCP","MSFT\\x205\\x2e0","Online","ETH","2\\x3a16","desktop","1","1","0","","0","56637"),new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.2","${x('192.168.100.31')}","${x('aa:bb:cc:00:00:31')}","SSID5","DHCP","","Online","WIFI","0\\x3a37","iPhone","1","1","0","","0","80000"),new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.3","${x('192.168.100.44')}","${x('aa:bb:cc:00:00:44')}","SSID1","DHCP","","Offline","WIFI","0\\x3a0","tv","1","0","0","","0",""),null);`;

export const IP_FILTER_PAGE = `
var portFilters = new Array(new stPortFilter("InternetGatewayDevice.X_HW_Security","1","0","Custom"),null);
var FilterIn = new Array(new stFilterIn("InternetGatewayDevice.X_HW_Security.IpFilterIn.3","","TCP","Downstream","${x('192.168.100.250')}","","","","","","","","","Block\\x20test"),null);
<input type="hidden" name="onttoken" id="hwonttoken" value="10403e71ab7741169fd252b637f4efbb">`;

export const FIREWALL_LOG_PAGE = `
<textarea name="logarea" id="logarea" class="text_log" wrap="off" readonly="readonly"></textarea>
<script type="text/javascript">
document.getElementById("logarea").value ='Manufacturer\\x3aHuawei\\x3b\\x0d\\x0aSerialNumber\\x3aSECRET\\x3b\\x0d\\x0aIP\\x3a100\\x2e64\\x2e1\\x2e2\\x3b\\x0d\\x0a2026\\x2d11\\x2d15\\x2010\\x3a51\\x3a28\\x20\\x5bNotice\\x5d\\x20IN\\x3dInternet_DHCP\\x20OUT\\x3dLocalNetwork\\x20Direction\\x3dPublic\\x2d\\x3ePrivate\\x20Action\\x3dDeny\\x20SRC\\x3d203\\x2e0\\x2e113\\x2e7\\x20DST\\x3d192\\x2e168\\x2e100\\x2e20\\x20PROTO\\x3dTCP\\x20SPT\\x3d443\\x20DPT\\x3d60514\\x0d\\x0a';
</script>`;

export const LOGIN_REDIRECT_PAGE = `<html><head><script>top.location.href='/login.asp';</script></head></html>`;
